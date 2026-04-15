import {mkdir, writeFile} from "node:fs/promises";
import {createInterface} from "node:readline/promises";
import net from "node:net";
import {stdin as input, stdout as output} from "node:process";
import tls from "node:tls";
import {URLSearchParams} from "node:url";
import path from "node:path";
import {Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher} from "undici";
import {SocksClient} from "socks";
import makeFetchCookie from "fetch-cookie";
import {CookieJar} from "tough-cookie";
import {appConfig} from "./config.js";
import {defaultDeviceProfile, type DeviceProfile, getDeviceClientHints} from "./device-profile.js";
import {
    AUTH_AUTHORIZE_CONTINUE_URL,
    AUTH_BASE_URL,
    AUTH_EMAIL_OTP_SEND_URL,
    AUTH_EMAIL_OTP_VALIDATE_URL,
    AUTH_OAUTH_TOKEN_URLS,
    AUTH_PASSWORD_VERIFY_URL,
    AUTH_REGISTER_URL,
    AUTH_WORKSPACE_SELECT_URL,
    CHATGPT_BASE_URL,
    DEFAULT_CLIENT_ID,
    DEFAULT_REDIRECT_URI,
    DEFAULT_USER_AGENT,
} from "./constants.js";
import {getEmailAddress, getEmailVerificationCode, MAILBOX_CONFIG} from "./mailbox.js";
import {fetchSentinelToken} from "./sentinel.js";
import {pkceCodeChallenge, randomUrlSafeString,} from "./utils.js";

type FetchLike = typeof fetch;

const DEFAULT_INSECURE_TLS = true;
const FETCH_RETRY_COUNT = 3;
const FETCH_RETRY_DELAY_MS = 1500;

function resolveProxyUrl(): string {
    return appConfig.defaultProxyUrl;
}

function shouldAllowInsecureTLS(): boolean {
    return DEFAULT_INSECURE_TLS;
}

function createDispatcher(proxyUrl: string, allowInsecureTLS: boolean): Dispatcher {
    if (!proxyUrl) {
        return new Agent({
            connect: {
                rejectUnauthorized: !allowInsecureTLS,
            },
        });
    }

    const parsedProxyUrl = new URL(proxyUrl);
    if (parsedProxyUrl.protocol === "http:" || parsedProxyUrl.protocol === "https:") {
        return new ProxyAgent({
            uri: proxyUrl,
            requestTls: {
                rejectUnauthorized: !allowInsecureTLS,
            },
        });
    }

    if (isSocksProtocol(parsedProxyUrl.protocol)) {
        const connect = ((options, callback) => {
            void createSocksSocket(parsedProxyUrl, options as unknown as Record<string, unknown>, allowInsecureTLS)
                .then((socket) => callback(null, socket))
                .catch((error) => callback(error instanceof Error ? error : new Error(String(error)), null));
        }) as NonNullable<ConstructorParameters<typeof Agent>[0]>["connect"];

        return new Agent({
            connect,
        });
    }

    throw new Error(`不支持的代理协议: ${parsedProxyUrl.protocol}`);
}

function isSocksProtocol(protocol: string): boolean {
    return ["socks4:", "socks4a:", "socks5:", "socks5h:"].includes(protocol);
}

async function createSocksSocket(
    proxyUrl: URL,
    options: Record<string, unknown>,
    allowInsecureTLS: boolean,
): Promise<net.Socket> {
    const destinationHost = String(options.hostname ?? "");
    const rawPort = options.port;
    const destinationPort =
        rawPort === "" || rawPort == null
            ? (options.protocol === "https:" ? 443 : 80)
            : Number(rawPort);
    const proxyPort = Number(proxyUrl.port || (proxyUrl.protocol.startsWith("socks5") ? 1080 : 1080));
    const proxyType = proxyUrl.protocol.startsWith("socks4") ? 4 : 5;

    const connection = await SocksClient.createConnection({
        proxy: {
            host: proxyUrl.hostname,
            port: proxyPort,
            type: proxyType,
            userId: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined,
        },
        command: "connect",
        destination: {
            host: destinationHost,
            port: destinationPort,
        },
    });

    const socket = connection.socket;
    if (options.protocol !== "https:") {
        return socket;
    }

    return await new Promise<net.Socket>((resolve, reject) => {
        const tlsSocket = tls.connect({
            socket,
            host: String(options.servername ?? destinationHost),
            servername: String(options.servername ?? destinationHost),
            rejectUnauthorized: !allowInsecureTLS,
        });
        tlsSocket.once("secureConnect", () => resolve(tlsSocket));
        tlsSocket.once("error", reject);
    });
}

interface ContinueResponse {
    continue_url: string;
    method?: string;
    page?: {
        type?: string;
        backstack_behavior?: string;
        payload?: {
            url?: string;
        };
    };
}

interface AuthSessionWorkspace {
    id: string;
    name?: string;
    kind?: string;
}

interface ClientAuthSessionPayload {
    workspaces?: AuthSessionWorkspace[];
}

interface OAuthTokenResponse {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
}

interface JwtPayload {
    email?: string;
    exp?: number;
    "https://api.openai.com/auth"?: {
        chatgpt_account_id?: string;
    };
}

export interface AuthLoginResult {
    callbackURL: string;
    code: string;
    state: string;
    authFile?: string;
}

export interface SavedAuthRecord {
    access_token: string;
    account_id: string;
    disabled: boolean;
    email: string;
    expired: string;
    id_token: string;
    last_refresh: string;
    refresh_token: string;
    type: "codex";
    websockets: false;
}

export interface OpenAIClientOptions {
    email?: string;
    password: string;
    userAgent?: string;
    deviceProfile?: DeviceProfile;
    manualMode?: boolean;
    signupScreenHint?: string;
}

export class OpenAIClient {
    email: string;
    readonly password: string;
    readonly manualMode: boolean;
    readonly jar: CookieJar;
    readonly fetch: FetchLike;
    readonly userAgent: string;
    readonly deviceProfile: DeviceProfile;
    readonly clientHints: ReturnType<typeof getDeviceClientHints>;
    readonly signupScreenHint: string;
    state = "";
    codeVerifier = "";
    deviceID = "";

    constructor(options: OpenAIClientOptions) {
        this.email = options.email?.trim() ?? "";
        this.password = options.password;
        this.deviceProfile = options.deviceProfile
            ? {
                ...options.deviceProfile,
                languages: [...options.deviceProfile.languages],
            }
            : {
                ...defaultDeviceProfile(),
                userAgent: options.userAgent?.trim() || DEFAULT_USER_AGENT,
            };
        this.userAgent = this.deviceProfile.userAgent;
        this.clientHints = getDeviceClientHints(this.deviceProfile);
        this.manualMode = options.manualMode ?? !this.email;
        this.signupScreenHint = options.signupScreenHint?.trim() || "login_or_signup";
        this.jar = new CookieJar();
        setGlobalDispatcher(createDispatcher(resolveProxyUrl(), shouldAllowInsecureTLS()));
        const cookieFetch = makeFetchCookie(fetch, this.jar) as FetchLike;
        this.fetch = ((input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) =>
            this.fetchWithRetry(cookieFetch, input, init)) as FetchLike;
    }

    private logProgress(current: number, total: number, message: string): void {
        console.log(`[${current}/${total}] ${message}`);
    }

    async authLoginHTTP(): Promise<AuthLoginResult> {
        const totalSteps = 6;
        this.logProgress(1, totalSteps, "打开登录授权页");
        const oauthUrl = this.prepareManualLogin();
        const oauthResp = await this.fetch(oauthUrl, {
            redirect: "follow",
            headers: this.createBrowserHeaders({
                "accept-encoding": "gzip, deflate, br",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "none",
            }),
        });
        if (!oauthResp.ok) {
            throw new Error(`OauthUrl请求失败: ${oauthResp.status}`);
        }
        if (oauthResp.url.startsWith(DEFAULT_REDIRECT_URI)) {
            const result = this.extractAuthResult(oauthResp.url);
            const authRecord = await this.exchangeCodeForToken(result.code);
            const authPath = await this.saveAuthRecord(authRecord);
            result.authFile = authPath;
            return result;
        }
        if (
            oauthResp.url !== `${AUTH_BASE_URL}/log-in` &&
            oauthResp.url !== `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`
        ) {
            throw new Error(`OauthUrl重定向到错误的URL: ${oauthResp.url}`);
        }

        this.deviceID = await this.readCookie("https://openai.com", "oai-did");
        if (!this.deviceID) {
            throw new Error("OauthUrl未返回oai-did cookie");
        }

        if (oauthResp.url === `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`) {
            this.logProgress(5, totalSteps, "选择工作区");
            const continueURL = await this.selectWorkspace(oauthResp.url);
            this.logProgress(6, totalSteps, "交换授权并保存凭证");
            const result = await this.followOAuthRedirects(continueURL);
            const authRecord = await this.exchangeCodeForToken(result.code);
            const authPath = await this.saveAuthRecord(authRecord);
            result.authFile = authPath;
            return result;
        }

        this.logProgress(2, totalSteps, "提交登录邮箱");
        let continueURL = await this.authorizeContinue();
        if (continueURL === `${AUTH_BASE_URL}/log-in/password`) {
            this.logProgress(3, totalSteps, "提交登录密码");
            continueURL = await this.passwordVerify();
        }

        if (continueURL === `${AUTH_BASE_URL}/email-verification`) {
            this.logProgress(4, totalSteps, "提交邮箱验证码");
            continueURL = await this.emailOtpValidate();
        }

        if (continueURL === `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`) {
            this.logProgress(5, totalSteps, "选择工作区");
            continueURL = await this.selectWorkspace(continueURL);
        }

        this.logProgress(6, totalSteps, "交换授权并保存凭证");
        const result = await this.followOAuthRedirects(continueURL);
        const authRecord = await this.exchangeCodeForToken(result.code);
        const authPath = await this.saveAuthRecord(authRecord);
        result.authFile = authPath;
        return result;
    }

    async authRegisterHTTP(): Promise<string> {
        const stepMessages = [
            "初始化注册会话",
            "生成注册邮箱",
            "打开注册页",
            "提交注册邮箱",
        ];
        let totalSteps = stepMessages.length;
        let step = 1;
        this.logProgress(step++, totalSteps, "初始化注册会话");
        await this.bootChatGPTSession();
        this.logProgress(step++, totalSteps, "生成注册邮箱");
        this.email = await this.generateRegisterEmail();
        console.log("registerEmail:", this.email);
        this.logProgress(step++, totalSteps, "打开注册页");
        await this.openSignupPage(this.email);

        this.logProgress(step++, totalSteps, "提交注册邮箱");
        let continueURL = await this.authorizeContinueForSignup();

        if (continueURL === `${AUTH_BASE_URL}/create-account/password`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "提交注册密码");
            continueURL = await this.registerPassword();
        }

        if (continueURL === AUTH_EMAIL_OTP_SEND_URL) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "发送邮箱验证码");
            continueURL = await this.sendEmailOtp();
        }

        if (continueURL === `${AUTH_BASE_URL}/email-verification`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "提交邮箱验证码");
            continueURL = await this.emailOtpValidate();
        }

        if (continueURL === `${AUTH_BASE_URL}/about-you`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "填写基础资料");
            continueURL = await this.completeAboutYou();
        }

        if (continueURL.startsWith(`${CHATGPT_BASE_URL}/api/auth/callback/openai`)) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "完成注册");
            await this.finishChatGPTRegistration(continueURL);
            console.log(`[注册成功] 邮箱：${this.email} 密码：${this.password}`);
        }

        return continueURL;
    }

    async authRegisterAndAuthorizeHTTP(): Promise<AuthLoginResult> {
        const stepMessages = [
            "打开直接注册授权页",
            "提交注册邮箱",
        ];
        let totalSteps = stepMessages.length;
        let step = 1;

        if (!this.email) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "生成注册邮箱");
            this.email = await this.generateRegisterEmail();
            console.log("registerEmail:", this.email);
        }

        this.logProgress(step++, totalSteps, "打开直接注册授权页");
        await this.openDirectSignupAuthorizePage(this.email);

        this.logProgress(step++, totalSteps, "提交注册邮箱");
        let continueURL = await this.authorizeContinueForSignup(this.signupScreenHint);

        if (continueURL === `${AUTH_BASE_URL}/create-account/password`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "提交注册密码");
            continueURL = await this.registerPassword();
        }

        if (continueURL === AUTH_EMAIL_OTP_SEND_URL) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "发送邮箱验证码");
            continueURL = await this.sendEmailOtp();
        }

        if (continueURL === `${AUTH_BASE_URL}/email-verification`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "提交邮箱验证码");
            continueURL = await this.emailOtpValidate();
        }

        if (continueURL === `${AUTH_BASE_URL}/about-you`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "填写基础资料");
            continueURL = await this.completeAboutYou();
        }

        if (continueURL === `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "选择工作区");
            continueURL = await this.selectWorkspace(continueURL);
        }

        totalSteps += 1;
        this.logProgress(step++, totalSteps, "交换授权并保存凭证");
        return await this.finalizeAuthorizationFromContinueURL(continueURL);
    }

    prepareManualLogin(prompt: "login" | "none" = "login"): string {
        this.state = randomUrlSafeString(24);
        this.codeVerifier = randomUrlSafeString(64);
        const query = new URLSearchParams({
            client_id: DEFAULT_CLIENT_ID,
            response_type: "code",
            redirect_uri: DEFAULT_REDIRECT_URI,
            scope: "openid email profile offline_access",
            state: this.state,
            code_challenge: pkceCodeChallenge(this.codeVerifier),
            code_challenge_method: "S256",
            prompt,
            id_token_add_organizations: "true",
            codex_cli_simplified_flow: "true",
        });
        return `${AUTH_BASE_URL}/oauth/authorize?${query.toString()}`;
    }

    async authorizeContinue(): Promise<string> {
        const sentinelToken = await this.fetchSentinelToken("authorize_continue");
        const response = await this.fetch(AUTH_AUTHORIZE_CONTINUE_URL, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "openai-sentinel-token": sentinelToken,
                "user-agent": this.userAgent,
                "accept-language": this.deviceProfile.acceptLanguage,
                "sec-ch-ua": this.clientHints.secChUa,
                "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            },
            body: JSON.stringify({
                username: {
                    kind: "email",
                    value: this.email,
                },
            }),
        });
        if (!response.ok) {
            throw new Error(
                `AuthorizeContinue请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async authorizeContinueForSignup(screenHint = "login_or_signup"): Promise<string> {
        const sentinelToken = await this.fetchSentinelToken("authorize_continue");
        const response = await this.postJSON(
            AUTH_AUTHORIZE_CONTINUE_URL,
            {
                username: {
                    kind: "email",
                    value: this.email,
                },
                screen_hint: screenHint,
            },
            {
                referer: `${AUTH_BASE_URL}/log-in-or-create-account?usernameKind=email`,
                sentinelToken,
            },
        );
        if (!response.ok) {
            throw new Error(
                `AuthorizeContinue注册请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async passwordVerify(): Promise<string> {
        const sentinelToken = await this.fetchSentinelToken("password_verify");
        const response = await this.postJSON(
            AUTH_PASSWORD_VERIFY_URL,
            {
                password: this.password,
            },
            {
                referer: `${AUTH_BASE_URL}/log-in/password`,
                sentinelToken,
            },
        );
        if (!response.ok) {
            throw new Error(
                `PasswordVerify请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async emailOtpValidate(): Promise<string> {
        const code = await this.resolveEmailOtpCode();
        const response = await this.fetch(AUTH_EMAIL_OTP_VALIDATE_URL, {
            method: "POST",
            headers: {
                accept: "application/json",
                "content-type": "application/json",
                origin: AUTH_BASE_URL,
                referer: `${AUTH_BASE_URL}/email-verification`,
                "user-agent": this.userAgent,
            },
            body: JSON.stringify({code}),
        });
        if (!response.ok) {
            throw new Error(
                `EmailOtpValidate请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async registerPassword(): Promise<string> {
        const sentinelToken = await this.fetchSentinelToken("username_password_create");
        const response = await this.postJSON(
            AUTH_REGISTER_URL,
            {
                password: this.password,
                username: this.email,
            },
            {
                referer: `${AUTH_BASE_URL}/create-account/password`,
                sentinelToken,
            },
        );
        if (!response.ok) {
            throw new Error(
                `RegisterPassword请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async sendEmailOtp(): Promise<string> {
        const response = await this.fetch(AUTH_EMAIL_OTP_SEND_URL, {
            method: "GET",
            headers: {
                accept: "application/json",
                referer: `${AUTH_BASE_URL}/create-account/password`,
                "user-agent": this.userAgent,
                "accept-language": this.deviceProfile.acceptLanguage,
                "sec-ch-ua": this.clientHints.secChUa,
                "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            },
        });
        if (!response.ok) {
            throw new Error(
                `EmailOtpSend请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async selectWorkspace(consentURL: string): Promise<string> {
        await this.fetch(consentURL, {
            method: "GET",
            headers: {
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                referer: `${AUTH_BASE_URL}/email-verification`,
                "user-agent": this.userAgent,
                "accept-language": this.deviceProfile.acceptLanguage,
                "sec-ch-ua": this.clientHints.secChUa,
                "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            },
        });

        const workspaceID = await this.resolveWorkspaceID();
        const response = await this.fetch(AUTH_WORKSPACE_SELECT_URL, {
            method: "POST",
            headers: {
                accept: "application/json",
                "content-type": "application/json",
                origin: AUTH_BASE_URL,
                referer: consentURL,
                "user-agent": this.userAgent,
                "accept-language": this.deviceProfile.acceptLanguage,
                "sec-ch-ua": this.clientHints.secChUa,
                "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            },
            body: JSON.stringify({
                workspace_id: workspaceID,
            }),
        });
        if (!response.ok) {
            throw new Error(
                `WorkspaceSelect请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async followOAuthRedirects(startURL: string): Promise<AuthLoginResult> {
        let currentURL = startURL;
        for (let hop = 0; hop < 10; hop++) {
            const response = await this.fetch(currentURL, {
                method: "GET",
                redirect: "manual",
                headers: {
                    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "user-agent": this.userAgent,
                    "accept-language": this.deviceProfile.acceptLanguage,
                    "sec-ch-ua": this.clientHints.secChUa,
                    "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                    "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                    "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                    "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                    "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
                },
            });

            const location = response.headers.get("location");
            if (location) {
                const nextURL = new URL(location, currentURL).toString();
                if (nextURL.startsWith(`${AUTH_BASE_URL}/add-phone`)) {
                    throw new Error("当前账号在登录后触发了 add-phone 绑手机流程，无法直接完成授权");
                }
                if (nextURL.startsWith(DEFAULT_REDIRECT_URI)) {
                    return this.extractAuthResult(nextURL);
                }
                currentURL = nextURL;
                continue;
            }

            if (response.url.startsWith(`${AUTH_BASE_URL}/add-phone`)) {
                throw new Error("当前账号在登录后触发了 add-phone 绑手机流程，无法直接完成授权");
            }

            if (response.url.startsWith(DEFAULT_REDIRECT_URI)) {
                return this.extractAuthResult(response.url);
            }

            throw new Error(
                `OAuth跳转未到达callback: status=${response.status} url=${response.url}`,
            );
        }

        throw new Error(`OAuth跳转次数过多，最后停在: ${currentURL}`);
    }

    private async finalizeAuthorizationFromContinueURL(startURL: string): Promise<AuthLoginResult> {
        if (startURL.startsWith(DEFAULT_REDIRECT_URI)) {
            const result = this.extractAuthResult(startURL);
            const authRecord = await this.exchangeCodeForToken(result.code);
            result.authFile = await this.saveAuthRecord(authRecord);
            return result;
        }

        const result = await this.followOAuthRedirects(startURL);
        const authRecord = await this.exchangeCodeForToken(result.code);
        result.authFile = await this.saveAuthRecord(authRecord);
        return result;
    }

    async fetchSentinelToken(
        flow:
            | "authorize_continue"
            | "password_verify"
            | "username_password_create"
            | "oauth_create_account",
    ): Promise<string> {
        return fetchSentinelToken({
            flow,
            deviceID: this.deviceID,
            fetch: this.fetch,
            reqEndpoint: "https://sentinel.openai.com/backend-api/sentinel/req",
            userAgent: this.userAgent,
            deviceProfile: this.deviceProfile,
        });
    }

    private async resolveEmailOtpCode(): Promise<string> {
        if (this.manualMode) {
            console.log(`manualEmailOtp: targetEmail=${this.email}`);
            return this.promptEmailOtp();
        }
        console.log(`autoEmailOtp: provider=${MAILBOX_CONFIG.provider} targetEmail=${this.email}`);
        return getEmailVerificationCode(this.email);
    }

    private async generateRegisterEmail(): Promise<string> {
        if (this.email) {
            return this.email;
        }
        return getEmailAddress();
    }

    private async promptEmailOtp(): Promise<string> {
        const rl = createInterface({input, output});
        try {
            const code = (await rl.question("请输入邮箱验证码: ")).trim();
            if (!/^\d{6}$/.test(code)) {
                throw new Error(`邮箱验证码格式不正确: ${code}`);
            }
            return code;
        } finally {
            rl.close();
        }
    }

    private async completeAboutYou(): Promise<string> {
        const sentinelToken = await this.fetchSentinelToken("oauth_create_account");
        const profile = this.randomProfile();
        console.log("registerProfile:", JSON.stringify(profile));

        const response = await this.postJSON(
            `${AUTH_BASE_URL}/api/accounts/create_account`,
            profile,
            {
                referer: `${AUTH_BASE_URL}/about-you`,
                sentinelToken,
            },
        );
        if (!response.ok) {
            throw new Error(
                `CreateAccount请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.page?.payload?.url ?? payload.continue_url;
    }

    private async finishChatGPTRegistration(callbackURL: string): Promise<void> {
        const response = await this.fetch(callbackURL, {
            method: "GET",
            redirect: "follow",
            headers: {
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                referer: `${AUTH_BASE_URL}/about-you`,
                "user-agent": this.userAgent,
                "accept-language": this.deviceProfile.acceptLanguage,
                "sec-ch-ua": this.clientHints.secChUa,
                "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            },
        });
        if (!response.ok) {
            throw new Error(`完成 ChatGPT 注册回调失败: ${response.status}`);
        }
    }

    private async exchangeCodeForToken(code: string): Promise<SavedAuthRecord> {
        let lastError = "";
        for (const tokenURL of AUTH_OAUTH_TOKEN_URLS) {
            const body = new URLSearchParams({
                grant_type: "authorization_code",
                client_id: DEFAULT_CLIENT_ID,
                code,
                redirect_uri: DEFAULT_REDIRECT_URI,
                code_verifier: this.codeVerifier,
            });
            const response = await this.fetch(tokenURL, {
                method: "POST",
                headers: this.createBrowserHeaders({
                    accept: "application/json",
                    "content-type": "application/x-www-form-urlencoded",
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-site",
                }),
                body,
            });
            if (!response.ok) {
                lastError = `endpoint=${tokenURL} ${await this.formatErrorResponse(response)}`;
                continue;
            }

            const payload = (await response.json()) as OAuthTokenResponse;
            return this.normalizeAuthRecord(payload);
        }

        throw new Error(`Code换Token失败: ${lastError}`);
    }

    private async resolveWorkspaceID(): Promise<string> {
        const cookie = await this.readCookie(
            AUTH_BASE_URL,
            "oai-client-auth-session",
        );
        if (!cookie) {
            throw new Error("未找到 oai-client-auth-session cookie，无法提取 workspace");
        }

        const encodedPayload = cookie.split(".")[0];
        const payload = this.decodeSignedJson<ClientAuthSessionPayload>(encodedPayload);
        const workspaceID =
            payload.workspaces?.find((w) => w.kind === "personal")?.id
            ?? payload.workspaces?.[0]?.id;
        if (!workspaceID) {
            throw new Error(`当前会话未发现 workspace: ${JSON.stringify(payload)}`);
        }
        return workspaceID;
    }

    private decodeSignedJson<T>(encoded: string): T {
        const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
        const json = Buffer.from(padded, "base64").toString("utf8");
        return JSON.parse(json) as T;
    }

    private normalizeAuthRecord(payload: OAuthTokenResponse): SavedAuthRecord {
        if (!payload.access_token) {
            throw new Error(`token响应缺少 access_token: ${JSON.stringify(payload)}`);
        }
        if (!payload.refresh_token) {
            throw new Error(`token响应缺少 refresh_token: ${JSON.stringify(payload)}`);
        }
        if (!payload.id_token) {
            throw new Error(`token响应缺少 id_token: ${JSON.stringify(payload)}`);
        }

        const accessClaims = this.decodeJwtPayload<JwtPayload>(payload.access_token);
        const idClaims = this.decodeJwtPayload<JwtPayload>(payload.id_token);
        const email = idClaims.email ?? accessClaims.email ?? this.email;
        const accountID =
            accessClaims["https://api.openai.com/auth"]?.chatgpt_account_id ??
            idClaims["https://api.openai.com/auth"]?.chatgpt_account_id ??
            "";
        const exp = accessClaims.exp;
        if (!accountID) {
            throw new Error(`token中缺少 account_id: ${JSON.stringify(accessClaims)}`);
        }
        if (!exp) {
            throw new Error(`access_token中缺少 exp: ${JSON.stringify(accessClaims)}`);
        }

        return {
            access_token: payload.access_token,
            account_id: accountID,
            disabled: false,
            email,
            expired: new Date(exp * 1000).toISOString(),
            id_token: payload.id_token,
            last_refresh: new Date().toISOString(),
            refresh_token: payload.refresh_token,
            type: "codex",
            websockets: false,
        };
    }

    private decodeJwtPayload<T>(token: string): T {
        const parts = token.split(".");
        if (parts.length < 2) {
            throw new Error(`JWT格式不正确: ${token.slice(0, 24)}...`);
        }
        return this.decodeSignedJson<T>(parts[1]);
    }

    private extractAuthResult(callbackURL: string): AuthLoginResult {
        const url = new URL(callbackURL);
        const code = url.searchParams.get("code") ?? "";
        const state = url.searchParams.get("state") ?? "";
        if (!code) {
            throw new Error(`callback 中缺少 code: ${callbackURL}`);
        }
        if (!state) {
            throw new Error(`callback 中缺少 state: ${callbackURL}`);
        }
        if (this.state && state !== this.state) {
            throw new Error(
                `callback state 不匹配: expected=${this.state} actual=${state}`,
            );
        }
        return {
            callbackURL,
            code,
            state,
        };
    }

    private async saveAuthRecord(record: SavedAuthRecord): Promise<string> {
        const authDir = path.resolve(process.cwd(), "auth");
        await mkdir(authDir, {recursive: true});
        const now = new Date();
        const date = [
            now.getFullYear(),
            `${now.getMonth() + 1}`.padStart(2, "0"),
            `${now.getDate()}`.padStart(2, "0"),
        ].join("-");
        const safeEmail = record.email.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
        const fileName = `${date}-${safeEmail}.json`;
        const filePath = path.join(authDir, fileName);
        await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
        return filePath;
    }

    private randomProfile(): { name: string; birthdate: string } {
        const firstNames = [
            "Ethan",
            "Noah",
            "Liam",
            "Mason",
            "Lucas",
            "Logan",
            "Owen",
            "Ryan",
            "Leo",
            "Adam",
            "Ella",
            "Ava",
            "Mia",
            "Luna",
            "Chloe",
            "Grace",
            "Ruby",
            "Nora",
            "Ivy",
            "Sofia",
        ];
        const lastNames = [
            "Smith",
            "Brown",
            "Taylor",
            "Walker",
            "Wilson",
            "Clark",
            "Hall",
            "Young",
            "Allen",
            "King",
            "Scott",
            "Green",
            "Baker",
            "Adams",
            "Turner",
        ];
        const age = this.randomInt(25, 34);
        const today = new Date();
        const birthYear = today.getFullYear() - age;
        const birthMonth = this.randomInt(1, 12);
        const maxDay = new Date(birthYear, birthMonth, 0).getDate();
        const birthDay = this.randomInt(1, maxDay);

        return {
            name: `${this.pick(firstNames)} ${this.pick(lastNames)}`,
            birthdate: [
                birthYear,
                `${birthMonth}`.padStart(2, "0"),
                `${birthDay}`.padStart(2, "0"),
            ].join("-"),
        };
    }

    private pick<T>(items: T[]): T {
        return items[Math.floor(Math.random() * items.length)];
    }

    private randomInt(min: number, max: number): number {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    private async bootChatGPTSession(): Promise<void> {
        const response = await this.fetch(`${CHATGPT_BASE_URL}/`, {
            method: "GET",
            redirect: "follow",
            headers: this.createBrowserHeaders({
                "accept-encoding": "gzip, deflate, br",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "none",
            }),
        });
        if (!response.ok) {
            throw new Error(`打开 chatgpt.com 失败: ${response.status}`);
        }

        this.deviceID =
            (await this.readCookie(CHATGPT_BASE_URL, "oai-did")) ||
            (await this.readCookie("https://openai.com", "oai-did"));
        if (!this.deviceID) {
            throw new Error("chatgpt.com 未返回 oai-did cookie");
        }
    }

    private async openSignupPage(email: string): Promise<void> {
        const csrfCookie = await this.readCookie(
            CHATGPT_BASE_URL,
            "__Host-next-auth.csrf-token",
        );
        const csrfToken = decodeURIComponent(csrfCookie).split("|")[0] ?? "";
        if (!csrfToken) {
            throw new Error("未找到 __Host-next-auth.csrf-token，无法打开注册页");
        }

        const query = new URLSearchParams({
            prompt: "login",
            "ext-oai-did": this.deviceID,
            auth_session_logging_id: globalThis.crypto.randomUUID(),
            "ext-passkey-client-capabilities": "0111",
            screen_hint: "login_or_signup",
            login_hint: email,
        });
        const body = new URLSearchParams({
            callbackUrl: `${CHATGPT_BASE_URL}/`,
            csrfToken,
            json: "true",
        });

        const response = await this.fetch(
            `${CHATGPT_BASE_URL}/api/auth/signin/openai?${query.toString()}`,
            {
                method: "POST",
                redirect: "follow",
                headers: this.createBrowserHeaders({
                    accept: "*/*",
                    "content-type": "application/x-www-form-urlencoded",
                    origin: CHATGPT_BASE_URL,
                    referer: `${CHATGPT_BASE_URL}/`,
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-origin",
                }),
                body,
            },
        );
        if (!response.ok) {
            throw new Error(`打开注册页失败: ${response.status}`);
        }

        const payload = (await response.json()) as { url?: string };
        if (!payload.url) {
            throw new Error(`打开注册页缺少跳转URL: ${JSON.stringify(payload)}`);
        }

        const authorizeResp = await this.fetch(payload.url, {
            method: "GET",
            redirect: "follow",
            headers: this.createBrowserHeaders({
                "accept-encoding": "gzip, deflate, br",
                referer: `${CHATGPT_BASE_URL}/`,
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "same-site",
            }),
        });
        if (!authorizeResp.ok) {
            throw new Error(`打开 OpenAI authorize 页失败: ${authorizeResp.status}`);
        }
    }

    private async postJSON(
        url: string,
        payload: unknown,
        options: {
            referer: string;
            sentinelToken?: string;
        },
    ): Promise<Response> {
        const headers = this.createBrowserHeaders({
            accept: "application/json",
            "content-type": "application/json",
            origin: AUTH_BASE_URL,
            referer: options.referer,
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
        });
        if (options.sentinelToken) {
            headers.set("openai-sentinel-token", options.sentinelToken);
        }
        return this.fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
        });
    }

    private async readCookie(url: string, key: string): Promise<string> {
        const cookies = await this.jar.getCookies(url);
        return cookies.find((cookie) => cookie.key === key)?.value ?? "";
    }

    private async openDirectSignupAuthorizePage(email: string): Promise<void> {
        const oauthUrl = this.prepareManualLogin();
        const authorizeUrl = new URL(oauthUrl);
        authorizeUrl.searchParams.set("screen_hint", this.signupScreenHint);
        authorizeUrl.searchParams.set("login_hint", email);

        const response = await this.fetch(authorizeUrl.toString(), {
            method: "GET",
            redirect: "follow",
            headers: this.createBrowserHeaders({
                "accept-encoding": "gzip, deflate, br",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "none",
            }),
        });
        if (!response.ok) {
            throw new Error(`打开直接注册授权页失败: ${response.status}`);
        }

        this.deviceID = await this.readCookie("https://openai.com", "oai-did");
        if (!this.deviceID) {
            throw new Error("直接注册授权页未返回 oai-did cookie");
        }
    }

    private createBrowserHeaders(init: Record<string, string>): Headers {
        return new Headers({
            "user-agent": this.userAgent,
            "accept-language": this.deviceProfile.acceptLanguage,
            "sec-ch-ua": this.clientHints.secChUa,
            "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
            "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
            "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
            "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
            "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            ...init,
        });
    }

    private async formatErrorResponse(response: Response): Promise<string> {
        const body = await response.text();
        try {
            const payload = JSON.parse(body) as {
                error?: {
                    code?: string | null;
                };
            };
            const code = payload.error?.code;
            if (code) {
                return `${response.status} code=${code}`;
            }
        } catch {
            // ignore parse error and fall back to raw body
        }
        return `${response.status} body=${body}`;
    }

    private async fetchWithRetry(
        baseFetch: FetchLike,
        input: Parameters<FetchLike>[0],
        init?: Parameters<FetchLike>[1],
    ): Promise<Response> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= FETCH_RETRY_COUNT; attempt++) {
            try {
                return await baseFetch(input, init);
            } catch (error) {
                lastError = error;
                if (!isRetryableFetchError(error) || attempt >= FETCH_RETRY_COUNT) {
                    throw error;
                }
                console.log(
                    `[网络重试 ${attempt}/${FETCH_RETRY_COUNT}] ${this.describeRetryTarget(input)} ${this.describeRetryError(error)}`,
                );
                console.log(`[延迟] 网络重试等待 ${FETCH_RETRY_DELAY_MS * attempt}ms`);
                await sleep(FETCH_RETRY_DELAY_MS * attempt);
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private describeRetryTarget(input: Parameters<FetchLike>[0]): string {
        if (typeof input === "string") {
            return input;
        }
        if (input instanceof URL) {
            return input.toString();
        }
        if (typeof Request !== "undefined" && input instanceof Request) {
            return input.url;
        }
        return "unknown-url";
    }

    private describeRetryError(error: unknown): string {
        const cause = getErrorCause(error);
        if (!cause) {
            return error instanceof Error ? error.message : String(error);
        }
        const code = "code" in cause ? String((cause as { code?: unknown }).code ?? "") : "";
        return code ? `${cause.message} (${code})` : cause.message;
    }
}

function isRetryableFetchError(error: unknown): boolean {
    const message = collectErrorMessages(error).join(" ").toLowerCase();
    return [
        "econnreset",
        "etimedout",
        "socket hang up",
        "proxy connection timed out",
        "fetch failed",
        "eai_again",
        "ecannotassignrequestedaddress",
        "ehostunreach",
        "enetunreach",
    ].some((keyword) => message.includes(keyword));
}

function getErrorCause(error: unknown): Error | null {
    if (error instanceof Error && error.cause instanceof Error) {
        return error.cause;
    }
    return error instanceof Error ? error : null;
}

function collectErrorMessages(error: unknown): string[] {
    const messages: string[] = [];
    if (error instanceof Error) {
        messages.push(error.message);
        if (error.cause instanceof Error) {
            messages.push(error.cause.message);
            const code = "code" in error.cause ? String((error.cause as { code?: unknown }).code ?? "") : "";
            if (code) {
                messages.push(code);
            }
        }
        const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
        if (code) {
            messages.push(code);
        }
    } else if (error != null) {
        messages.push(String(error));
    }
    return messages;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
