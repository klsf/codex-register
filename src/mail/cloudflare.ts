import {appConfig} from "../config.js";
import {generateEmailName} from "./generate-email-name.js";
import {fetch as undiciFetch, Agent, ProxyAgent, type Dispatcher, type RequestInit as UndiciRequestInit} from "undici";
import {findLatestVerificationMail} from "./verification-matcher.js";


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

function buildMailbox(email: string): string {
    const mailbox = normalizeEmail(email);
    if (!mailbox.includes("@")) {
        throw new Error(`邮箱格式不正确: ${email}`);
    }
    return mailbox;
}

function buildDispatcher(): Dispatcher {
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

async function cloudflareFetch(input: string | URL, init: UndiciRequestInit = {}) {
    return undiciFetch(input, {
        ...init,
        dispatcher: buildDispatcher(),
    } satisfies UndiciRequestInit);
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

            for (let attempt = 1; attempt <= CLOUDFLARE_POLL_ATTEMPTS; attempt += 1) {
                const latestMail = await fetchLatestMailbox(email);
                const mailboxList = await fetchMailboxList(email);
                const candidates = [
                    ...(latestMail ? [latestMail] : []),
                    ...(mailboxList.emails ?? []),
                ].map((mail) => ({
                    ...mail,
                    id: mail.id == null ? String(mail.message_id ?? "") : String(mail.id),
                    sender: String(mail.from_email ?? ""),
                    recipient: String(mail.mailbox ?? ""),
                    subject: String(mail.subject ?? ""),
                    content: String(mail.raw_text ?? ""),
                    timestamp: Number(mail.received_at ?? 0),
                }));
                const matchedMail = findLatestVerificationMail(candidates, {
                    targetEmail: buildMailbox(email),
                });
                if (matchedMail?.verificationCode) {
                    console.log(`cloudflareOtpCode: ${matchedMail.verificationCode}`);
                    return matchedMail.verificationCode;
                }

                if (attempt < CLOUDFLARE_POLL_ATTEMPTS) {
                    await new Promise((resolve) => setTimeout(resolve, CLOUDFLARE_POLL_INTERVAL_MS));
                }
            }

            throw new Error(`Cloudflare 邮箱中未找到验证码: targetEmail=${email}`);
        },
    };
}
