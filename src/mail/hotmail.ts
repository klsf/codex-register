// @ts-nocheck
import {readFile, readdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {generateEmailName} from "./generate-email-name.js";

const HOTMAIL_TOKEN_DIR = path.resolve(process.cwd(), "hotmail");
const HOTMAIL_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const HOTMAIL_OAUTH_TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const HOTMAIL_POLL_ATTEMPTS = 36;
const HOTMAIL_POLL_INTERVAL_MS = 5000;
const HOTMAIL_MESSAGE_FETCH_LIMIT = 10;
const HOTMAIL_FOLDER_IDS = ["inbox", "junkemail"];
const aliasAccountMap = new Map();
const lastVerificationCodeByEmail = new Map();
let accountCache = null;

function normalizeEmail(value) {
    return String(value ?? "").trim().toLowerCase();
}

function extractVerificationCode(text) {
    const raw = String(text ?? "");
    if (!raw) {
        return "";
    }

    const directMatch = raw.match(/\b(\d{6})\b/);
    if (directMatch?.[1]) {
        return directMatch[1];
    }

    const compactMatch = raw
        .replace(/<[^>]+>/g, " ")
        .match(/(?:^|[^\d])((?:\d[\s-]*){6})(?:[^\d]|$)/);
    if (!compactMatch?.[1]) {
        return "";
    }

    const digitsOnly = compactMatch[1].replace(/\D/g, "");
    return digitsOnly.length === 6 ? digitsOnly : "";
}

function decodeJwtPayload(token) {
    const parts = String(token ?? "").split(".");
    if (parts.length < 2) {
        return {};
    }
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    try {
        return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    } catch {
        return {};
    }
}

function getTokenExpireAtMs(account) {
    const payload = decodeJwtPayload(account.accessToken);
    const exp = Number(payload.exp ?? 0);
    if (exp > 0) {
        return exp * 1000;
    }

    const obtainedAt = Date.parse(String(account.obtainedAt ?? ""));
    const expiresIn = Number(account.expiresIn ?? 0);
    if (Number.isFinite(obtainedAt) && expiresIn > 0) {
        return obtainedAt + expiresIn * 1000;
    }

    return 0;
}

function isAccessTokenExpired(account) {
    const expireAtMs = getTokenExpireAtMs(account);
    if (!expireAtMs) {
        return false;
    }
    return Date.now() >= expireAtMs - 60 * 1000;
}

function parseAccountFileName(fileName) {
    const match = String(fileName).match(/^(.+?)--(.+)\.json$/i);
    const loginHint = normalizeEmail(match?.[1] ?? "");
    const sourceAccount = String(match?.[2] ?? "").trim();
    return {
        loginHint,
        sourceAccount,
    };
}

async function loadAccounts() {
    if (accountCache) {
        return accountCache;
    }

    const fileNames = await readdir(HOTMAIL_TOKEN_DIR);
    const accounts = [];

    for (const fileName of fileNames) {
        if (!fileName.toLowerCase().endsWith(".json")) {
            continue;
        }

        const filePath = path.join(HOTMAIL_TOKEN_DIR, fileName);
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        const fileInfo = parseAccountFileName(fileName);
        const loginHint = normalizeEmail(parsed?.login_hint ?? fileInfo.loginHint);
        const accessToken = String(parsed?.access_token ?? "").trim();
        const refreshToken = String(parsed?.refresh_token ?? "").trim();

        if (!loginHint || !accessToken || !refreshToken) {
            continue;
        }

        accounts.push({
            fileName,
            filePath,
            loginHint,
            sourceAccount: String(parsed?.source_account ?? fileInfo.sourceAccount),
            tenant: String(parsed?.tenant ?? "consumers") || "consumers",
            clientId: String(parsed?.client_id ?? "").trim(),
            redirectUri: String(parsed?.redirect_uri ?? "").trim(),
            scope: String(parsed?.scope ?? "openid profile User.Read Mail.ReadWrite Mail.Send Mail.Read").trim(),
            tokenType: String(parsed?.token_type ?? "Bearer").trim(),
            accessToken,
            refreshToken,
            idToken: String(parsed?.id_token ?? "").trim(),
            obtainedAt: String(parsed?.obtained_at ?? ""),
            expiresIn: Number(parsed?.expires_in ?? 0),
            extExpiresIn: Number(parsed?.ext_expires_in ?? 0),
            raw: parsed,
        });
    }

    if (!accounts.length) {
        throw new Error(`未在目录找到 Hotmail token 文件: ${HOTMAIL_TOKEN_DIR}`);
    }

    accountCache = accounts;
    return accounts;
}

async function persistAccount(account) {
    const payload = {
        ...account.raw,
        obtained_at: account.obtainedAt,
        tenant: account.tenant,
        client_id: account.clientId,
        redirect_uri: account.redirectUri,
        login_hint: account.loginHint,
        source_account: account.sourceAccount,
        token_type: account.tokenType,
        scope: account.scope,
        expires_in: account.expiresIn,
        ext_expires_in: account.extExpiresIn,
        access_token: account.accessToken,
        refresh_token: account.refreshToken,
        id_token: account.idToken,
    };

    await writeFile(account.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    account.raw = payload;
}

async function refreshAccessToken(account) {
    if (!account.clientId || !account.redirectUri || !account.refreshToken) {
        throw new Error(`Hotmail token 缺少刷新所需字段: ${account.fileName}`);
    }

    const body = new URLSearchParams({
        client_id: account.clientId,
        grant_type: "refresh_token",
        refresh_token: account.refreshToken,
        redirect_uri: account.redirectUri,
        scope: account.scope || "openid profile User.Read Mail.ReadWrite Mail.Send Mail.Read",
    });

    const response = await fetch(HOTMAIL_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
    });

    const rawBody = await response.text();
    if (!response.ok) {
        throw new Error(`Hotmail 刷新 token 失败: ${response.status} body=${rawBody}`);
    }

    const payload = JSON.parse(rawBody);
    account.accessToken = String(payload?.access_token ?? "").trim();
    account.refreshToken = String(payload?.refresh_token ?? account.refreshToken).trim();
    account.idToken = String(payload?.id_token ?? account.idToken ?? "").trim();
    account.tokenType = String(payload?.token_type ?? account.tokenType ?? "Bearer").trim();
    account.scope = String(payload?.scope ?? account.scope).trim();
    account.expiresIn = Number(payload?.expires_in ?? account.expiresIn ?? 0);
    account.extExpiresIn = Number(payload?.ext_expires_in ?? account.extExpiresIn ?? 0);
    account.obtainedAt = new Date().toISOString();

    await persistAccount(account);
    console.log(`hotmailTokenRefreshed: ${account.loginHint}`);
    return account;
}

async function ensureFreshAccount(account) {
    if (isAccessTokenExpired(account)) {
        await refreshAccessToken(account);
    }
    return account;
}

function buildAuthHeaders(account) {
    return {
        Accept: "application/json",
        Authorization: `Bearer ${account.accessToken}`,
    };
}

async function graphRequest(account, url) {
    await ensureFreshAccount(account);

    let response = await fetch(url, {
        method: "GET",
        headers: buildAuthHeaders(account),
    });

    if (response.status === 401) {
        await refreshAccessToken(account);
        response = await fetch(url, {
            method: "GET",
            headers: buildAuthHeaders(account),
        });
    }

    if (!response.ok) {
        throw new Error(`Hotmail Graph 请求失败: ${response.status} body=${await response.text()}`);
    }

    return response.json();
}

function chooseRandomAccount(accounts) {
    return accounts[Math.floor(Math.random() * accounts.length)];
}

function buildAliasAddress(account) {
    const mailbox = normalizeEmail(account.loginHint);
    const [localPart, domain] = mailbox.split("@");
    if (!localPart || !domain) {
        throw new Error(`Hotmail 邮箱格式不正确: ${account.loginHint}`);
    }
    return `${localPart}+${generateEmailName()}@${domain}`;
}

function normalizeRecipientList(recipients) {
    if (!Array.isArray(recipients)) {
        return [];
    }
    return recipients
        .map((item) => normalizeEmail(item?.emailAddress?.address ?? item?.address ?? ""))
        .filter(Boolean);
}

function normalizeMessage(message, folderId) {
    const bodyContent = String(message?.body?.content ?? "");
    return {
        id: String(message?.id ?? ""),
        folderId,
        subject: String(message?.subject ?? ""),
        bodyContent,
        bodyPreview: String(message?.bodyPreview ?? ""),
        from: normalizeEmail(message?.from?.emailAddress?.address ?? ""),
        toRecipients: normalizeRecipientList(message?.toRecipients),
        receivedDateTime: String(message?.receivedDateTime ?? ""),
        receivedAtMs: Date.parse(String(message?.receivedDateTime ?? "")) || 0,
        raw: message,
    };
}

function messageMatchesTarget(message, targetEmail) {
    const normalizedTarget = normalizeEmail(targetEmail);
    if (!normalizedTarget) {
        return false;
    }
    return message.toRecipients.includes(normalizedTarget);
}

function formatMessageDebug(message) {
    return JSON.stringify({
        id: message?.id ?? "",
        folderId: message?.folderId ?? "",
        receivedDateTime: message?.receivedDateTime ?? "",
        from: message?.from ?? "",
        toRecipients: Array.isArray(message?.toRecipients) ? message.toRecipients : [],
        subject: message?.subject ?? "",
        bodyPreview: String(message?.bodyPreview ?? "").slice(0, 160),
    });
}

async function listFolderMessages(account, folderId) {
    const url = new URL(`${HOTMAIL_GRAPH_BASE_URL}/me/mailFolders/${encodeURIComponent(folderId)}/messages`);
    url.searchParams.set("$top", String(HOTMAIL_MESSAGE_FETCH_LIMIT));
    url.searchParams.set("$orderby", "receivedDateTime desc");
    url.searchParams.set("$select", "id,subject,bodyPreview,body,from,toRecipients,receivedDateTime");

    const payload = await graphRequest(account, url);
    return Array.isArray(payload?.value)
        ? payload.value.map((item) => normalizeMessage(item, folderId))
        : [];
}

async function getLatestVerificationMessage(targetEmail, account, previousCode = "") {
    const messages = [];

    for (const folderId of HOTMAIL_FOLDER_IDS) {
        const folderMessages = await listFolderMessages(account, folderId);
        messages.push(...folderMessages);
    }

    messages.sort((a, b) => b.receivedAtMs - a.receivedAtMs);

    console.log(`hotmailMessagesFetched: targetEmail=${targetEmail} mailbox=${account.loginHint} count=${messages.length}`);

    for (const message of messages) {
        if (!messageMatchesTarget(message, targetEmail)) {
            continue;
        }

        const verificationCode =
            extractVerificationCode(message.subject) ||
            extractVerificationCode(message.bodyPreview) ||
            extractVerificationCode(message.bodyContent);

        if (!verificationCode) {
            continue;
        }
        if (previousCode && verificationCode === previousCode) {
            continue;
        }

        return {
            ...message,
            verificationCode,
        };
    }

    return null;
}

async function resolveAccountForEmail(email) {
    const normalizedEmail = normalizeEmail(email);
    const mapped = aliasAccountMap.get(normalizedEmail);
    if (mapped) {
        return mapped;
    }

    const accounts = await loadAccounts();
    const [localPart, domain] = normalizedEmail.split("@");
    const baseLocalPart = String(localPart ?? "").split("+")[0];

    const matched = accounts.find((account) => {
        const [accountLocalPart, accountDomain] = normalizeEmail(account.loginHint).split("@");
        return accountLocalPart === baseLocalPart && accountDomain === domain;
    });

    if (matched) {
        aliasAccountMap.set(normalizedEmail, matched);
        return matched;
    }

    throw new Error(`Hotmail 未找到与邮箱匹配的 token: ${email}`);
}

export function createHotmailProvider() {
    return {
        async getEmailAddress() {
            const accounts = await loadAccounts();
            const account = chooseRandomAccount(accounts);
            const aliasEmail = buildAliasAddress(account);
            aliasAccountMap.set(normalizeEmail(aliasEmail), account);
            return aliasEmail;
        },
        async getEmailVerificationCode(email) {
            const normalizedEmail = normalizeEmail(email);
            const account = await resolveAccountForEmail(email);
            const previousCode = lastVerificationCodeByEmail.get(normalizedEmail) ?? "";

            for (let attempt = 1; attempt <= HOTMAIL_POLL_ATTEMPTS; attempt += 1) {
                console.log(
                    `pollHotmailOtp: attempt=${attempt}/${HOTMAIL_POLL_ATTEMPTS} targetEmail=${email} mailbox=${account.loginHint}`,
                );

                const message = await getLatestVerificationMessage(email, account, previousCode);
                if (message?.verificationCode) {
                    lastVerificationCodeByEmail.set(normalizedEmail, message.verificationCode);
                    console.log(`hotmailOtpCode: ${message.verificationCode}`);
                    console.log(`hotmailOtpFolder: ${message.folderId}`);
                    return message.verificationCode;
                }

                if (attempt < HOTMAIL_POLL_ATTEMPTS) {
                    await new Promise((resolve) => setTimeout(resolve, HOTMAIL_POLL_INTERVAL_MS));
                }
            }

            throw new Error(`Hotmail 中未找到验证码: targetEmail=${email}`);
        },
    };
}
