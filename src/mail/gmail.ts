// @ts-nocheck
import {appConfig} from "../config.js";
import {generateEmailName} from "./generate-email-name.js";

const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1";
const GMAIL_USER_ID = "me";
const GMAIL_DOMAINS = ["gmail.com", "googlemail.com"];
const GMAIL_POLL_ATTEMPTS = 36;
const GMAIL_POLL_INTERVAL_MS = 5000;
const GMAIL_MAX_RESULTS = 10;
const lastVerificationCodeByEmail = new Map();

function buildAuthHeaders() {
    if (!appConfig.gmailAccessToken) {
        throw new Error("Gmail access token 未配置，请先在 config.json 中填写 gmailAccessToken");
    }
    return new Headers({
        Accept: "application/json",
        Authorization: `Bearer ${appConfig.gmailAccessToken}`,
    });
}

async function gmailRequest(path, query = {}) {
    const url = new URL(`${GMAIL_API_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(query)) {
        if (value == null || value === "") {
            continue;
        }
        url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
        method: "GET",
        headers: buildAuthHeaders(),
    });

    if (!response.ok) {
        throw new Error(`Gmail 请求失败: ${response.status} body=${await response.text()}`);
    }

    return response.json();
}

async function gmailDeleteRequest(path) {
    const response = await fetch(`${GMAIL_API_BASE_URL}${path}`, {
        method: "DELETE",
        headers: buildAuthHeaders(),
    });

    if (!response.ok) {
        throw new Error(`Gmail 删除请求失败: ${response.status} body=${await response.text()}`);
    }
}

function decodeBase64Url(value) {
    if (!value) {
        return "";
    }
    const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return Buffer.from(padded, "base64").toString("utf8");
}

function buildGmailAlias(email) {
    const [localPart] = String(email).split("@");
    if (!localPart) {
        throw new Error(`Gmail 邮箱格式不正确: ${email}`);
    }

    const domain = GMAIL_DOMAINS[Math.floor(Math.random() * GMAIL_DOMAINS.length)];
    return `${localPart}+${generateEmailName()}@${domain}`;
}

function collectBodyText(payload, chunks = []) {
    if (!payload) {
        return chunks;
    }

    if (payload.body?.data) {
        chunks.push(decodeBase64Url(payload.body.data));
    }

    if (Array.isArray(payload.parts)) {
        for (const part of payload.parts) {
            collectBodyText(part, chunks);
        }
    }

    return chunks;
}

function getHeaderValue(payload, name) {
    const headers = Array.isArray(payload?.headers) ? payload.headers : [];
    const match = headers.find(
        (item) => String(item?.name ?? "").toLowerCase() === name.toLowerCase(),
    );
    return String(match?.value ?? "");
}

function normalizeEmail(value) {
    const input = String(value ?? "").trim().toLowerCase();
    const angleMatch = input.match(/<([^>]+)>/);
    return (angleMatch?.[1] ?? input).trim();
}

export function extractVerificationCode(text) {
    if (!text) {
        return "";
    }
    const match = String(text).match(/\b(\d{6})\b/);
    return match?.[1] ?? "";
}

export async function listMessagesByRecipient(targetEmail) {
    const q = [
        `to:${targetEmail}`,
        '(subject:"Your ChatGPT code" OR subject:"Your OpenAI code")',
    ].join(" ");

    const payload = await gmailRequest(`/users/${encodeURIComponent(GMAIL_USER_ID)}/messages`, {
        q,
        maxResults: GMAIL_MAX_RESULTS,
    });

    return Array.isArray(payload.messages) ? payload.messages : [];
}

export async function getMessage(messageId) {
    const payload = await gmailRequest(
        `/users/${encodeURIComponent(GMAIL_USER_ID)}/messages/${encodeURIComponent(messageId)}`,
        {
            format: "full",
        },
    );

    const bodyContent = collectBodyText(payload.payload).join("\n").trim();
    const toAddress = getHeaderValue(payload.payload, "To");
    const subject = getHeaderValue(payload.payload, "Subject");
    const from = getHeaderValue(payload.payload, "From");

    return {
        id: payload.id ?? messageId,
        threadId: payload.threadId ?? "",
        labelIds: Array.isArray(payload.labelIds) ? payload.labelIds : [],
        snippet: payload.snippet ?? "",
        internalDate: Number(payload.internalDate ?? 0),
        toAddress,
        subject,
        from,
        bodyContent,
        payload,
    };
}

export async function getLatestVerificationMessage(targetEmail) {
    const messages = await listMessagesByRecipient(targetEmail);
    const details = [];

    for (const item of messages) {
        const message = await getMessage(item.id);
        if (normalizeEmail(message.toAddress) !== normalizeEmail(targetEmail)) {
            continue;
        }

        const code =
            extractVerificationCode(message.subject) ||
            extractVerificationCode(message.bodyContent) ||
            extractVerificationCode(message.snippet);

        details.push({
            ...message,
            verificationCode: code,
        });
    }

    details.sort((a, b) => b.internalDate - a.internalDate);
    return details.find((item) => item.verificationCode) ?? null;
}

export async function deleteMessage(messageId) {
    await gmailDeleteRequest(
        `/users/${encodeURIComponent(GMAIL_USER_ID)}/messages/${encodeURIComponent(messageId)}`,
    );
}

export function createGmailProvider() {
    return {
        async getEmailAddress() {
            if (!appConfig.gmailEmailAddress) {
                throw new Error("Gmail 邮箱地址未配置，请先在 config.json 中填写 gmailEmailAddress");
            }
            return buildGmailAlias(appConfig.gmailEmailAddress);
        },
        async getEmailVerificationCode(email) {
            const normalizedEmail = normalizeEmail(email);
            for (let attempt = 1; attempt <= GMAIL_POLL_ATTEMPTS; attempt += 1) {
                console.log(
                    `pollGmailOtp: attempt=${attempt}/${GMAIL_POLL_ATTEMPTS} targetEmail=${email}`,
                );

                const message = await getLatestVerificationMessage(email);
                if (message?.verificationCode) {
                    const previousCode =
                        lastVerificationCodeByEmail.get(normalizedEmail) ?? "";
                    if (previousCode && message.verificationCode === previousCode) {
                        console.log(`gmailOtpCode: ${message.verificationCode}`);
                        if (attempt < GMAIL_POLL_ATTEMPTS) {
                            await new Promise((resolve) =>
                                setTimeout(resolve, GMAIL_POLL_INTERVAL_MS),
                            );
                        }
                        continue;
                    }

                    await deleteMessage(message.id);
                    lastVerificationCodeByEmail.set(normalizedEmail, message.verificationCode);
                    console.log(`gmailOtpCode: ${message.verificationCode}`);
                    return message.verificationCode;
                }

                if (attempt < GMAIL_POLL_ATTEMPTS) {
                    await new Promise((resolve) =>
                        setTimeout(resolve, GMAIL_POLL_INTERVAL_MS),
                    );
                }
            }

            throw new Error(`Gmail 中未找到验证码: targetEmail=${email}`);
        },
    };
}

async function main() {
    const targetEmail = process.argv[2] ?? "";
    if (!targetEmail) {
        throw new Error("运行 gmail.js 时需要传入目标邮箱参数");
    }

    const provider = createGmailProvider();
    const code = await provider.getEmailVerificationCode(targetEmail);
    console.log(`verificationCode=${code}`);
}

