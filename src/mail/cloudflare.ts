import {appConfig} from "../config.js";
import {createRequire} from "node:module";
import {generateEmailName} from "./generate-email-name.js";

const require = createRequire(import.meta.url);
const {
    ProxyAgent,
    Agent,
}: {
    ProxyAgent: new (options: { uri: string; requestTls?: { rejectUnauthorized?: boolean } }) => unknown;
    Agent: new (options?: { connect?: { rejectUnauthorized?: boolean } }) => unknown;
} = require("undici");

interface CloudflareMailItem {
    id?: number;
    mailbox?: string;
    from_email?: string;
    subject?: string;
    message_id?: string;
    raw_text?: string;
    received_at?: number;
}

interface CloudflareMailboxListPayload {
    mailbox?: string;
    emails?: CloudflareMailItem[];
    limit?: number;
    offset?: number;
}

interface CloudflareLatestMailPayload extends CloudflareMailItem {}

const CLOUDFLARE_POLL_ATTEMPTS = 36;
const CLOUDFLARE_POLL_INTERVAL_MS = 5000;

const lastVerificationCodeByEmail = new Map<string, string>();

function normalizeEmail(value: string): string {
    return String(value ?? "").trim().toLowerCase();
}

function normalizeDomain(value: string): string {
    return String(value ?? "").trim().toLowerCase().replace(/^@+/, "");
}

function ensureDomainConfigured(): string {
    const domain = normalizeDomain(appConfig.cloudflareEmailDomain);
    if (!domain) {
        throw new Error("cloudflareEmailDomain 未配置，请先在 config.json 中填写 Cloudflare 邮箱域名");
    }
    return domain;
}

function ensureApiBaseUrlConfigured(): string {
    const baseUrl = String(appConfig.cloudflareApiBaseUrl ?? "").trim();
    if (!baseUrl) {
        throw new Error("cloudflareApiBaseUrl 未配置，请先在 config.json 中填写 Cloudflare 邮件 Worker 地址");
    }
    return baseUrl.replace(/\/+$/, "");
}

function ensureApiKeyConfigured(): string {
    const apiKey = String(appConfig.cloudflareApiKey ?? "").trim();
    if (!apiKey) {
        throw new Error("cloudflareApiKey 未配置，请先在 config.json 中填写 Cloudflare 邮件 Worker 密钥");
    }
    return apiKey;
}

function extractVerificationCode(text: string): string {
    const raw = String(text ?? "");
    if (!raw) {
        return "";
    }

    const directMatch = raw.match(/\b(\d{6})\b/);
    if (directMatch?.[1]) {
        return directMatch[1];
    }

    const compactMatch = raw.replace(/<[^>]+>/g, " ").match(/(?:^|[^\d])((?:\d[\s-]*){6})(?:[^\d]|$)/);
    if (!compactMatch?.[1]) {
        return "";
    }

    const digitsOnly = compactMatch[1].replace(/\D/g, "");
    return digitsOnly.length === 6 ? digitsOnly : "";
}

function buildMailbox(email: string): string {
    const mailbox = normalizeEmail(email);
    if (!mailbox.includes("@")) {
        throw new Error(`邮箱格式不正确: ${email}`);
    }
    return mailbox;
}

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

async function cloudflareFetch(input: string | URL, init: RequestInit = {}) {
    return fetch(input, {
        ...init,
        dispatcher: buildDispatcher(),
    } as RequestInit & { dispatcher: unknown });
}

async function fetchLatestMailbox(email: string): Promise<CloudflareLatestMailPayload | null> {
    const mailbox = buildMailbox(email);
    const baseUrl = ensureApiBaseUrlConfigured();
    const apiKey = ensureApiKeyConfigured();
    const url = new URL(`${baseUrl}/latest`);
    url.searchParams.set("to", mailbox);

    const response = await cloudflareFetch(url, {
        method: "GET",
        headers: {
            Accept: "application/json",
            "x-api-key": apiKey,
        },
    });

    if (response.status === 404) {
        return null;
    }

    if (!response.ok) {
        throw new Error(`Cloudflare 邮箱请求失败: ${response.status} body=${await response.text()}`);
    }

    return await response.json() as CloudflareLatestMailPayload;
}

async function fetchMailboxList(email: string): Promise<CloudflareMailboxListPayload> {
    const mailbox = buildMailbox(email);
    const baseUrl = ensureApiBaseUrlConfigured();
    const apiKey = ensureApiKeyConfigured();
    const url = new URL(`${baseUrl}/emails`);
    url.searchParams.set("to", mailbox);
    url.searchParams.set("limit", "10");

    const response = await cloudflareFetch(url, {
        method: "GET",
        headers: {
            Accept: "application/json",
            "x-api-key": apiKey,
        },
    });

    if (!response.ok) {
        throw new Error(`Cloudflare 邮箱列表请求失败: ${response.status} body=${await response.text()}`);
    }

    const payload = await response.json() as CloudflareMailboxListPayload;
    if (!Array.isArray(payload?.emails)) {
        throw new Error(`Cloudflare 邮箱返回格式异常: ${JSON.stringify(payload)}`);
    }

    return payload;
}

function findVerificationCode(mail: CloudflareMailItem | null | undefined): { verificationCode: string; source: string } | null {
    if (!mail) {
        return null;
    }

    const subject = String(mail.subject ?? "");
    const rawText = String(mail.raw_text ?? "");
    const subjectCode = extractVerificationCode(subject);
    if (subjectCode) {
        return {
            verificationCode: subjectCode,
            source: subject,
        };
    }

    const rawTextCode = extractVerificationCode(rawText);
    if (rawTextCode) {
        return {
            verificationCode: rawTextCode,
            source: rawText,
        };
    }

    return null;
}

export function createCloudflareProvider() {
    return {
        async getEmailAddress() {
            const domain = ensureDomainConfigured();
            return `${generateEmailName()}@${domain}`;
        },
        async getEmailVerificationCode(email: string) {
            ensureDomainConfigured();
            ensureApiBaseUrlConfigured();
            ensureApiKeyConfigured();

            const normalizedEmail = normalizeEmail(email);
            const previousCode = lastVerificationCodeByEmail.get(normalizedEmail) ?? "";

            for (let attempt = 1; attempt <= CLOUDFLARE_POLL_ATTEMPTS; attempt += 1) {
                const latestMail = await fetchLatestMailbox(email);
                const latestMatch = findVerificationCode(latestMail);
                if (latestMatch?.verificationCode && latestMatch.verificationCode !== previousCode) {
                    lastVerificationCodeByEmail.set(normalizedEmail, latestMatch.verificationCode);
                    console.log(`cloudflareOtpCode: ${latestMatch.verificationCode}`);
                    return latestMatch.verificationCode;
                }

                if (latestMatch?.verificationCode && latestMatch.verificationCode === previousCode) {
                    if (attempt < CLOUDFLARE_POLL_ATTEMPTS) {
                        await new Promise((resolve) => setTimeout(resolve, CLOUDFLARE_POLL_INTERVAL_MS));
                    }
                    continue;
                }

                const mailboxList = await fetchMailboxList(email);
                for (const mail of mailboxList.emails ?? []) {
                    const match = findVerificationCode(mail);
                    if (!match?.verificationCode || match.verificationCode === previousCode) {
                        continue;
                    }

                    lastVerificationCodeByEmail.set(normalizedEmail, match.verificationCode);
                    console.log(`cloudflareOtpCode: ${match.verificationCode}`);
                    return match.verificationCode;
                }

                if (attempt < CLOUDFLARE_POLL_ATTEMPTS) {
                    await new Promise((resolve) => setTimeout(resolve, CLOUDFLARE_POLL_INTERVAL_MS));
                }
            }

            throw new Error(`Cloudflare 邮箱中未找到验证码: targetEmail=${email}`);
        },
    };
}
