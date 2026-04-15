// @ts-nocheck
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {appConfig} from "../config.js";
import {generateEmailName} from "./generate-email-name.js";
import {Agent, ProxyAgent} from "undici";
import {findLatestVerificationMail} from "./verification-matcher.js";


const PROXIEDMAIL_BASE_URL = "https://proxiedmail.com/api/v1";
const PROXIEDMAIL_API_TOKEN = "1f925b5c7a6872b92cc11c56c2c1be6c";
const PROXIEDMAIL_REAL_ADDRESS = "proxiedmail@kuaileshifu.top";
const PROXIEDMAIL_DOMAINS = ["pxdmail.net", "pxdmail.com"];//proxiedmail.com 这个滥用了
const PROXIEDMAIL_SIGNUP_DOMAIN = "gmail.com";
const PROXIEDMAIL_SIGNUP_PASSWORD = "zxcv123456789..";
const PROXIEDMAIL_POLL_ATTEMPTS = 36;
const PROXIEDMAIL_POLL_INTERVAL_MS = 5000;
const PROXIEDMAIL_ACCOUNT_FILE = path.resolve(process.cwd(), "proxiedmail-account.json");

const bindingCache = new Map();
let currentApiToken = PROXIEDMAIL_API_TOKEN;
let currentRealAddress = PROXIEDMAIL_REAL_ADDRESS;
let accountStateLoaded = false;

function buildDispatcher() {
    const proxyUrl = String(appConfig.defaultProxyUrl ?? "").trim();
    return proxyUrl
        ? new ProxyAgent({
            uri: proxyUrl,
            requestTls: {rejectUnauthorized: false},
        })
        : new Agent({
            connect: {rejectUnauthorized: false},
        });
}

async function proxiedFetch(input, init = {}) {
    return fetch(input, {
        ...init,
        //dispatcher: buildDispatcher(),//使用代理
    });
}

async function loadPersistedAccountState() {
    if (accountStateLoaded) {
        return;
    }
    accountStateLoaded = true;

    try {
        const raw = await readFile(PROXIEDMAIL_ACCOUNT_FILE, "utf8");
        const payload = JSON.parse(raw);
        const apiToken = String(payload?.apiToken ?? "").trim();
        const username = String(payload?.username ?? "").trim();
        if (apiToken) {
            currentApiToken = apiToken;
        }
        if (username) {
            currentRealAddress = username;
        }
    } catch {
        // ignore missing or invalid persisted account file
    }
}

async function persistAccountState() {
    await writeFile(
        PROXIEDMAIL_ACCOUNT_FILE,
        `${JSON.stringify({
            username: currentRealAddress,
            apiToken: currentApiToken,
            updatedAt: new Date().toISOString(),
        }, null, 2)}\n`,
        "utf8",
    );
}

function buildHeaders(apiToken = currentApiToken) {
    if (!apiToken) {
        throw new Error("ProxiedMail API Token 未配置，请先在 proxiedmail.js 中填写 PROXIEDMAIL_API_TOKEN");
    }

    return new Headers({
        Accept: "application/json",
        "Content-Type": "application/json",
        Token: apiToken,
    });
}

function buildProxyAddress() {
    const domain = PROXIEDMAIL_DOMAINS[Math.floor(Math.random() * PROXIEDMAIL_DOMAINS.length)];
    return `${generateEmailName()}@${domain}`;
}

async function requestJSON(path, options = {}) {
    await loadPersistedAccountState();
    const response = await proxiedFetch(`${PROXIEDMAIL_BASE_URL}${path}`, {
        ...options,
        headers: options.headers ?? buildHeaders(),
    });

    if (!response.ok) {
        throw new Error(`ProxiedMail 请求失败: ${response.status} body=${await response.text()}`);
    }

    return response.json();
}

function buildBrowserLikeHeaders(extraHeaders = {}) {
    return new Headers({
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: "https://proxiedmail.com",
        Referer: "https://proxiedmail.com/en/signup",
        ...extraHeaders,
    });
}

function parseCreatedAtMs(value) {
    const ms = Date.parse(String(value ?? ""));
    return Number.isFinite(ms) ? ms : 0;
}

function decodeHtmlEntities(text) {
    return String(text ?? "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&amp;/gi, "&");
}

function buildSignupUsername() {
    return `${generateEmailName()}@${PROXIEDMAIL_SIGNUP_DOMAIN}`;
}

async function registerProxiedMailAccount() {
    const username = buildSignupUsername();
    const response = await proxiedFetch(`${PROXIEDMAIL_BASE_URL}/users`, {
        method: "POST",
        headers: buildBrowserLikeHeaders({
            Referer: "https://proxiedmail.com/en/signup",
            "Guest-Id": "undefined",
        }),
        body: JSON.stringify({
            data: {
                type: "users",
                attributes: {
                    username,
                    password: PROXIEDMAIL_SIGNUP_PASSWORD,
                    wasAuthenticated: "",
                    keyLandingPage: "",
                    v: "zalupavvvvvvvggggzalupa0000000000000gggggg",
                },
            },
        }),
    });

    if (!response.ok) {
        throw new Error(`ProxiedMail 注册账号失败: ${response.status} body=${await response.text()}`);
    }

    const payload = await response.json();
    const accessToken = payload?.data?.attributes?.token ?? "";
    if (!accessToken) {
        throw new Error(`ProxiedMail 注册账号返回异常: ${JSON.stringify(payload)}`);
    }

    return {
        username,
        accessToken,
        raw: payload,
    };
}

async function exchangeApiToken(accessToken) {
    const response = await proxiedFetch(`${PROXIEDMAIL_BASE_URL}/api-token`, {
        method: "GET",
        headers: buildBrowserLikeHeaders({
            Authorization: `Bearer ${accessToken}`,
            Referer: "https://proxiedmail.com/en/settings",
        }),
    });

    if (!response.ok) {
        throw new Error(`ProxiedMail 获取 API token 失败: ${response.status} body=${await response.text()}`);
    }

    const payload = await response.json();
    const apiToken = payload?.token ?? "";
    if (!apiToken) {
        throw new Error(`ProxiedMail API token 返回异常: ${JSON.stringify(payload)}`);
    }

    return apiToken;
}

async function rotateApiTokenByRegisteringAccount() {
    const account = await registerProxiedMailAccount();
    const apiToken = await exchangeApiToken(account.accessToken);
    currentApiToken = apiToken;
    currentRealAddress = account.username;
    await persistAccountState();
    console.log(`ProxiedMail注册成功：账号：${account.username} Token：${apiToken}`);
    return apiToken;
}

async function createProxyBinding(proxyAddress, options = {}) {
    const createPayload = () =>
        JSON.stringify({
            data: {
                type: "proxy_bindings",
                attributes: {
                    real_addresses: [currentRealAddress],
                    proxy_address: proxyAddress,
                    callback_url: "",
                    is_browsable: true,
                },
            },
        });

    let payload;
    try {
        payload = await requestJSON("/proxy-bindings", {
            method: "POST",
            body: createPayload(),
            headers: buildHeaders(options.apiToken),
        });
    } catch (error) {
        if (options.allowAccountRotation === false) {
            throw error;
        }
        const freshToken = await rotateApiTokenByRegisteringAccount();
        payload = await requestJSON("/proxy-bindings", {
            method: "POST",
            body: createPayload(),
            headers: buildHeaders(freshToken),
        });
    }

    const binding = payload?.data;
    if (!binding?.id || !binding?.attributes?.proxy_address) {
        throw new Error(`ProxiedMail 创建邮箱返回异常: ${JSON.stringify(payload)}`);
    }

    const normalized = {
        id: binding.id,
        proxyAddress: binding.attributes.proxy_address,
        raw: payload,
    };
    bindingCache.set(normalized.proxyAddress.toLowerCase(), normalized);
    return normalized;
}

async function listProxyBindings() {
    const payload = await requestJSON("/proxy-bindings", {
        method: "GET",
    });

    return Array.isArray(payload?.data) ? payload.data : [];
}

async function resolveProxyBindingByAddress(email) {
    const cached = bindingCache.get(String(email).toLowerCase());
    if (cached) {
        return cached;
    }

    const bindings = await listProxyBindings();
    const match = bindings.find(
        (item) =>
            String(item?.attributes?.proxy_address ?? "").toLowerCase() ===
            String(email).toLowerCase(),
    );

    if (!match?.id) {
        throw new Error(`ProxiedMail 未找到邮箱绑定: ${email}`);
    }

    const normalized = {
        id: match.id,
        proxyAddress: match.attributes.proxy_address,
        raw: match,
    };
    bindingCache.set(normalized.proxyAddress.toLowerCase(), normalized);
    return normalized;
}

async function listReceivedEmailLinks(proxyBindingId) {
    const payload = await requestJSON(
        `/received-emails-links/${encodeURIComponent(proxyBindingId)}`,
        {
            method: "GET",
        },
    );

    return Array.isArray(payload?.data) ? payload.data : [];
}

async function getReceivedEmail(receivedEmailId) {
    const payload = await requestJSON(
        `/received-emails/${encodeURIComponent(receivedEmailId)}`,
        {
            method: "GET",
        },
    );

    const data = payload?.data;
    const attributes = data?.attributes ?? {};
    const emailPayload = attributes.payload ?? {};
    return {
        id: data?.id ?? receivedEmailId,
        recipientEmail: attributes.recipient_email ?? emailPayload.recipient ?? "",
        senderEmail: attributes.sender_email ?? emailPayload.sender ?? "",
        subject: emailPayload.Subject ?? "",
        bodyPlain: emailPayload["body-plain"] ?? "",
        bodyHtml: emailPayload["body-html"] ?? "",
        createdAt: attributes.created_at ?? "",
        raw: payload,
    };
}

async function getLatestVerificationMessage(email, options = {}) {
    const binding = await resolveProxyBindingByAddress(email);
    const links = await listReceivedEmailLinks(binding.id);
    const detailed = [];
    for (const item of links) {
        const attributes = item?.attributes ?? {};
        const linkPath = String(attributes.link ?? "");
        const id = String(item?.id ?? "");
        const receivedEmailId =
            id || linkPath.split("/").filter(Boolean).at(-1) || "";
        if (!receivedEmailId) {
            continue;
        }

        const detail = await getReceivedEmail(receivedEmailId);
        detailed.push({
            ...detail,
            createdAtMs: parseCreatedAtMs(detail.createdAt),
            recipient: detail.recipientEmail,
            sender: detail.senderEmail,
            content: detail.bodyPlain,
            timestamp: parseCreatedAtMs(detail.createdAt),
            extraTexts: [detail.bodyHtml],
        });
    }

    return findLatestVerificationMail(detailed, {
        targetEmail: email,
    });
}

export function createProxiedMailProvider() {
    return {
        async getEmailAddress() {
            await loadPersistedAccountState();
            const proxyAddress = buildProxyAddress();
            const binding = await createProxyBinding(proxyAddress);
            return binding.proxyAddress;
        },
        async getEmailVerificationCode(email) {
            await loadPersistedAccountState();
            for (let attempt = 1; attempt <= PROXIEDMAIL_POLL_ATTEMPTS; attempt += 1) {
                console.log(
                    `pollProxiedMailOtp: attempt=${attempt}/${PROXIEDMAIL_POLL_ATTEMPTS} targetEmail=${email}`,
                );

                const message = await getLatestVerificationMessage(email);
                if (message?.verificationCode) {
                    console.log(`proxiedmailOtpCode: ${message.verificationCode}`);
                    return message.verificationCode;
                }

                if (attempt < PROXIEDMAIL_POLL_ATTEMPTS) {
                    await new Promise((resolve) =>
                        setTimeout(resolve, PROXIEDMAIL_POLL_INTERVAL_MS),
                    );
                }
            }

            throw new Error(`ProxiedMail 中未找到验证码: targetEmail=${email}`);
        },
    };
}

