// @ts-nocheck
import {createHash, randomBytes} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {appConfig} from "../config.js";
import {DEFAULT_USER_AGENT} from "../constants.js";
import {generateEmailName} from "./generate-email-name.js";
import {
    findLatestVerificationMail as findLatestVerificationMailByFields,
    normalizeMailbox,
} from "./verification-matcher.js";

const PROVIDER_DEVICE_UID = "28960a33-9af0-4ea7-9e1c-bccc5b7cc564";
const PROVIDER_POLL_ATTEMPTS = 36;
const PROVIDER_POLL_INTERVAL_MS = 5000;
const GENERATED_EMAIL_DOMAIN = "2925.com";
const WEB_LOGIN_URL = "https://www.2925.com/mailv2/auth/weblogin";
const MAIL_LIST_URL =
    "https://www.2925.com/mailv2/maildata/MailList/mails";
const MAIL_READ_URL =
    "https://www.2925.com/mailv2/maildata/MailRead/mails/read";
const MOVE_MAILS_URL =
    "https://www.2925.com/mailv2/maildata/MailData/mails/folder";
const SESSION_CACHE_DIR = process.cwd();
const SESSION_CACHE_FILE = path.join(SESSION_CACHE_DIR, "2925-account.json");
const MOBILE_USER_AGENT =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1 Edg/146.0.0.0";
let memorySession = null;

function getProviderMailbox() {
    if (!appConfig["2925EmailAddress"]) {
        throw new Error("2925 邮箱账号未配置，请先在 config.json 中填写 2925EmailAddress");
    }
    return appConfig["2925EmailAddress"];
}

function getProviderLoginPassword() {
    if (!appConfig["2925Password"]) {
        throw new Error("2925 邮箱密码未配置，请先在 config.json 中填写 2925Password");
    }
    return appConfig["2925Password"];
}

function randomTraceId() {
    return randomBytes(6).toString("hex");
}

function md5Lower(text) {
    return createHash("md5").update(String(text), "utf8").digest("hex");
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

function encodeFormBody(data) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
        body.set(key, String(value ?? ""));
    }
    return body.toString();
}

function buildDefaultCookie(options) {
    const mailbox = options.mailbox ?? "";
    const nickname = String(options.nickname ?? "");
    const uid = String(options.uid ?? "");
    const encodedMailbox = encodeURIComponent(mailbox);
    const pairs = [
        options.wtc || `_wtc=WTC.2.${Date.now()}.${Date.now()}`,
        `auc=${options.refreshToken}`,
        `aut=${options.bearerToken}`,
        `jwt_token=${options.bearerToken}`,
        `account=${encodedMailbox}`,
        `nickname=${encodeURIComponent(nickname)}`,
        `uid=${encodeURIComponent(uid)}`,
        "ano=undefined",
    ];
    return pairs.join("; ");
}

function buildMailListURL(options) {
    const query = new URLSearchParams({
        Folder: options.folder ?? "Inbox",
        MailBox: options.mailbox,
        FilterType: String(options.filterType ?? 0),
        PageIndex: String(options.pageIndex ?? 1),
        PageCount: String(options.pageCount ?? 25),
        traceId: options.traceId ?? randomTraceId(),
    });
    return `${MAIL_LIST_URL}?${query.toString()}`;
}

function buildHeaders(options) {
    const headers = new Headers({
        Accept: "application/json, text/plain, */*",
        Authorization: `Bearer ${options.bearerToken}`,
        Referer: "https://www.2925.com/",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
        "deviceUid": options.deviceUid,
        "sec-ch-ua":
            '"Chromium";v="146", "Not-A.Brand";v="24", "Microsoft Edge";v="146"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
    });

    headers.set("Cookie", options.cookie || buildDefaultCookie(options));

    return headers;
}

function extractSetCookieParts(headers) {
    const values = [];
    if (typeof headers.getSetCookie === "function") {
        values.push(...headers.getSetCookie());
    }
    const combined = headers.get("set-cookie");
    if (combined) {
        values.push(...combined.split(/,(?=[^;]+?=)/g));
    }
    return values
        .map((value) => String(value).split(";")[0].trim())
        .filter(Boolean);
}

function findCookieValue(cookieParts, key) {
    const prefix = `${key}=`;
    const matched = cookieParts.find((item) => item.startsWith(prefix));
    return matched ? matched.slice(prefix.length) : "";
}

function isTokenExpired(token) {
    const payload = decodeJwtPayload(token);
    const exp = Number(payload.exp ?? 0);
    if (!exp) {
        return false;
    }
    return Date.now() >= exp * 1000 - 60 * 1000;
}

function isSessionMailboxMatched(session) {
    if (!session?.mailbox) {
        return false;
    }
    return String(session.mailbox).trim().toLowerCase() === getProviderMailbox().trim().toLowerCase();
}

async function readCachedSession() {
    try {
        const raw = await readFile(SESSION_CACHE_FILE, "utf8");
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function saveCachedSession(session) {
    await mkdir(SESSION_CACHE_DIR, {recursive: true});
    await writeFile(`${SESSION_CACHE_FILE}`, `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

function normalizeLoginSession(payload, cookieParts) {
    const result = payload?.result ?? {};
    const appInfo = result.appInfo ?? {};
    const mailbox = String(appInfo.name ?? getProviderMailbox());
    const bearerToken = String(result.token ?? "");
    const refreshToken = String(result.refreashToken ?? "");
    const uid = String(appInfo.id ?? "");
    const nickname = String(appInfo.nickname ?? "");
    const wtc = findCookieValue(cookieParts, "_wtc") || `_wtc=WTC.2.${Date.now()}.${Date.now()}`;

    if (!bearerToken || !refreshToken || !uid || !mailbox) {
        throw new Error(`2925登录返回缺少关键字段: ${JSON.stringify(payload)}`);
    }

    return {
        mailbox,
        bearerToken,
        refreshToken,
        uid,
        nickname,
        deviceUid: PROVIDER_DEVICE_UID,
        wtc,
        cookie: buildDefaultCookie({
            mailbox,
            bearerToken,
            refreshToken,
            uid,
            nickname,
            wtc,
        }),
        savedAt: new Date().toISOString(),
        expiresAt: decodeJwtPayload(bearerToken).exp
            ? new Date(Number(decodeJwtPayload(bearerToken).exp) * 1000).toISOString()
            : "",
    };
}

async function login2925Mailbox() {
    const providerMailbox = getProviderMailbox();
    const providerLoginPassword = getProviderLoginPassword();
    const traceId = randomTraceId();
    const wtc = `_wtc=WTC.2.${Date.now()}.${Date.now()}`;
    const response = await fetch(`${WEB_LOGIN_URL}?traceId=${encodeURIComponent(traceId)}`, {
        method: "POST",
        headers: new Headers({
            Accept: "application/json, text/plain, */*",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: wtc,
            deviceUid: PROVIDER_DEVICE_UID,
            Origin: "https://www.2925.com",
            Priority: "u=1, i",
            Referer: "https://www.2925.com/login/",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
            "User-Agent": DEFAULT_USER_AGENT,
            "sec-ch-ua":
                '"Chromium";v="146", "Not-A.Brand";v="24", "Microsoft Edge";v="146"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
        }),
        body: encodeFormBody({
            uname: providerMailbox,
            rsapwd: md5Lower(providerLoginPassword),
            rememberLogin: true,
        }),
    });

    const rawBody = await response.text();
    if (!response.ok) {
        throw new Error(`2925登录请求失败: ${response.status} body=${rawBody}`);
    }

    const payload = JSON.parse(rawBody);
    if (payload?.code !== 200 || payload?.result?.success !== true) {
        throw new Error(`2925登录返回异常: ${rawBody}`);
    }

    const session = normalizeLoginSession(payload, extractSetCookieParts(response.headers));
    session.cookie = buildDefaultCookie({
        mailbox: session.mailbox,
        bearerToken: session.bearerToken,
        refreshToken: session.refreshToken,
        uid: session.uid,
        nickname: session.nickname,
        wtc,
    });
    memorySession = session;
    await saveCachedSession(session);
    console.log(`2925Login: success mailbox=${session.mailbox}`);
    return session;
}

async function get2925Session(forceRefresh = false) {
    if (
        !forceRefresh &&
        memorySession &&
        isSessionMailboxMatched(memorySession) &&
        !isTokenExpired(memorySession.bearerToken)
    ) {
        return memorySession;
    }

    if (!forceRefresh) {
        const cached = await readCachedSession();
        if (
            cached &&
            isSessionMailboxMatched(cached) &&
            !isTokenExpired(cached.bearerToken)
        ) {
            memorySession = cached;
            return cached;
        }
    }

    return login2925Mailbox();
}

function normalizeMailItem(item) {
    return {
        uid: item.uid,
        messageId: item.messageId ?? "",
        mailbox: item.mailBox ?? "",
        folder: item.folder ?? "",
        subject: item.subject ?? "",
        bodyContent: item.bodyContent ?? "",
        sender: item.sender?.sender ?? "",
        senderDisplay: item.sender?.senderDisplay ?? "",
        toAddress: Array.isArray(item.toAddress) ? item.toAddress : [],
        createTime: Number(item.createTime ?? 0),
        modifyDate: Number(item.modifyDate ?? 0),
        unRead: Boolean(item.unRead),
        raw: item,
    };
}

function buildMailReadURL(options) {
    const query = new URLSearchParams({
        MessageID: options.messageId,
        FolderName: options.folder ?? "Inbox",
        MailBox: options.mailbox,
        IsPre: "false",
        traceId: options.traceId ?? randomTraceId(),
    });
    return `${MAIL_READ_URL}?${query.toString()}`;
}

function buildMailReadHeaders(options) {
    const headers = new Headers({
        Accept: "application/json, text/plain, */*",
        Authorization: `Bearer ${options.bearerToken}`,
        Referer: "https://www.2925.com/mobile/",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent": MOBILE_USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
        "deviceUid": options.deviceUid,
        priority: "u=1, i",
        "sec-ch-ua":
            '"Chromium";v="146", "Not-A.Brand";v="24", "Microsoft Edge";v="146"',
        "sec-ch-ua-mobile": "?1",
        "sec-ch-ua-platform": '"iOS"',
    });
    headers.set("Cookie", options.cookie || buildDefaultCookie(options));
    return headers;
}

function normalizeEmail(value) {
    return String(value ?? "").trim().toLowerCase();
}

function findLatestVerificationMail(mails, options = {}) {
    const matcher = options.matcher ?? /(OpenAI|ChatGPT).*(code)|code.*(OpenAI|ChatGPT)/i;
    return findLatestVerificationMailByFields(
        mails.map((mail) => ({
            ...mail,
            recipient: mail.toAddress,
            content: mail.bodyContent,
            timestamp: mail.createTime,
        })),
        {
            targetEmail: options.targetEmail ?? options.email ?? options.mailbox,
            candidateMatcher: (mail) => matcher.test(`${mail.subject}\n${mail.content}\n${mail.sender}`),
        },
    );
}

async function fetchMailReadContent(options) {
    if (!options?.messageId) {
        throw new Error("messageId 不能为空");
    }

    const response = await fetch(buildMailReadURL(options), {
        method: "GET",
        headers: buildMailReadHeaders(options),
    });

    if (!response.ok) {
        throw new Error(`2925邮件内容请求失败: ${response.status} body=${await response.text()}`);
    }

    const payload = await response.json();
    if (payload?.code !== 200) {
        throw new Error(`2925邮件内容返回异常: ${JSON.stringify(payload)}`);
    }

    const raw = Array.isArray(payload.result) ? payload.result[0] ?? {} : payload.result ?? {};
    return {
        subject: String(raw.subject ?? ""),
        bodyContent: String(raw.bodyContent ?? ""),
        sender: String(raw.sender ?? ""),
        toAddress: Array.isArray(raw.toAddress)
            ? raw.toAddress
            : String(raw.toAddress ?? "")
                .split(/\s+/)
                .map((value) => value.trim())
                .filter(Boolean),
        raw: payload,
    };
}

async function fetchMailList(options) {
    if (!options?.mailbox) {
        throw new Error("mailbox 不能为空");
    }
    if (!options?.bearerToken) {
        throw new Error("bearerToken 不能为空");
    }
    if (!options?.deviceUid) {
        throw new Error("deviceUid 不能为空");
    }

    const url = buildMailListURL(options);
    const response = await fetch(url, {
        method: "GET",
        headers: buildHeaders(options),
    });

    if (!response.ok) {
        throw new Error(`2925邮件列表请求失败: ${response.status} body=${await response.text()}`);
    }

    const payload = await response.json();
    if (payload?.code !== 200) {
        throw new Error(`2925邮件列表返回异常: ${JSON.stringify(payload)}`);
    }

    const result = payload.result ?? {};
    const list = Array.isArray(result.list) ? result.list.map(normalizeMailItem) : [];

    return {
        code: payload.code,
        message: payload.message ?? "",
        totalCount: Number(result.totalCount ?? list.length),
        pageTotal: Number(result.pageTotal ?? 0),
        nowPageIndex: Number(result.nowPageIndex ?? options.pageIndex ?? 1),
        nowFilterType: Number(result.nowFilterType ?? options.filterType ?? 0),
        list,
        raw: payload,
    };
}

async function moveMailsToDeleted(options) {
    const mailList = options.mailList ?? (await fetchMailList(options));
    const messageIds = Array.isArray(options.messageIds)
        ? options.messageIds.filter((value) => Boolean(value))
        : mailList.list.map((item) => item.messageId).filter((value) => Boolean(value));

    if (messageIds.length === 0) {
        return {
            moved: false,
            count: 0,
            messageIds: [],
            raw: null,
        };
    }

    const traceId = options.traceId ?? randomTraceId();
    const response = await fetch(`${MOVE_MAILS_URL}?traceId=${encodeURIComponent(traceId)}`, {
        method: "PUT",
        headers: new Headers({
            ...Object.fromEntries(buildHeaders(options).entries()),
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: "https://www.2925.com",
        }),
        body: JSON.stringify({
            MailBox: options.mailbox,
            MessageIds: messageIds,
            Folder: options.folder ?? "Inbox",
            ToFolder: options.toFolder ?? "已删除",
        }),
    });

    if (!response.ok) {
        throw new Error(`2925删除邮件请求失败: ${response.status} body=${await response.text()}`);
    }

    const payload = await response.json();
    if (payload?.code !== 200 || payload?.result !== true) {
        throw new Error(`2925删除邮件返回异常: ${JSON.stringify(payload)}`);
    }

    return {
        moved: true,
        count: messageIds.length,
        messageIds,
        raw: payload,
    };
}

async function fetchLatestVerificationCode(options) {
    const mailList = await fetchMailList(options);
    const matcher = options.matcher ?? /(OpenAI|ChatGPT).*(code)|code.*(OpenAI|ChatGPT)/i;
    const sorted = [...mailList.list].sort((a, b) => b.createTime - a.createTime);
    let latestMail = findLatestVerificationMail(sorted, {
        targetEmail: options.targetEmail ?? options.email ?? options.mailbox,
        matcher,
    });

    if (!latestMail) {
        const normalizedTarget = normalizeMailbox(options.targetEmail ?? options.email ?? options.mailbox);
        for (const mail of sorted) {
            if (normalizedTarget) {
                const matchedRecipient = mail.toAddress.some(
                    (address) => normalizeMailbox(address) === normalizedTarget,
                );
                if (!matchedRecipient) {
                    continue;
                }
            }

            const summaryHaystack = `${mail.subject}\n${mail.bodyContent}\n${mail.sender}`;
            if (matcher.test(summaryHaystack)) {
                continue;
            }

            const detail = await fetchMailReadContent({
                ...options,
                messageId: mail.messageId,
                folder: mail.folder || "Inbox",
            });
            const matchedDetail = findLatestVerificationMail(
                [{
                    ...mail,
                    subject: detail.subject || mail.subject,
                    bodyContent: detail.bodyContent || mail.bodyContent,
                    sender: detail.sender || mail.sender,
                    toAddress: detail.toAddress?.length ? detail.toAddress : mail.toAddress,
                    createTime: mail.createTime,
                    detailRaw: detail.raw,
                }],
                {
                    targetEmail: options.targetEmail ?? options.email ?? options.mailbox,
                    matcher,
                },
            );
            if (matchedDetail) {
                latestMail = matchedDetail;
                break;
            }
        }
    }

    const deleteResult = latestMail
        ? await moveMailsToDeleted({
            ...options,
            mailList,
            messageIds: latestMail.messageId ? [latestMail.messageId] : [],
        })
        : {
            moved: false,
            count: 0,
            messageIds: [],
            raw: null,
        };

    return {
        ...mailList,
        latestMail,
        code: latestMail?.verificationCode ?? "",
        deleteResult,
    };
}

async function fetchLatestVerificationCodeWithSession(targetEmail) {
    let session = await get2925Session(false);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            const result = await fetchLatestVerificationCode({
                mailbox: session.mailbox,
                targetEmail,
                bearerToken: session.bearerToken,
                refreshToken: session.refreshToken,
                uid: session.uid,
                nickname: session.nickname,
                deviceUid: session.deviceUid,
                cookie: session.cookie,
            });
            return result;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const shouldRelogin =
                attempt === 1 &&
                (message.includes("401") ||
                    message.includes("\"code\":401") ||
                    message.includes("bearerToken") ||
                    message.includes("鉴权") ||
                    message.includes("登录"));
            if (!shouldRelogin) {
                throw error;
            }
            console.log("2925Session: expired, relogin");
            session = await get2925Session(true);
        }
    }

    throw new Error("2925邮箱获取验证码失败: 会话重试后仍未成功");
}

export function create2925Provider() {
    return {
        async getEmailAddress() {
            const providerMailbox = getProviderMailbox();
            const generatedPrefix = providerMailbox.includes("@")
                ? providerMailbox.slice(0, providerMailbox.indexOf("@"))
                : providerMailbox;
            return `${generatedPrefix}_${generateEmailName()}@${GENERATED_EMAIL_DOMAIN}`;
        },
        async getEmailVerificationCode(email) {
            for (let attempt = 1; attempt <= PROVIDER_POLL_ATTEMPTS; attempt += 1) {
                console.log(
                    `poll2925Otp: attempt=${attempt}/${PROVIDER_POLL_ATTEMPTS} targetEmail=${email}`,
                );

                const result = await fetchLatestVerificationCodeWithSession(email);

                if (result.code) {
                    console.log(`2925OtpCode: ${result.code}`);
                    console.log(
                        `autoEmailOtpDeletedCount: ${result.deleteResult?.count ?? 0}`,
                    );
                    return result.code;
                }

                if (attempt < PROVIDER_POLL_ATTEMPTS) {
                    await new Promise((resolve) =>
                        setTimeout(resolve, PROVIDER_POLL_INTERVAL_MS),
                    );
                }
            }

            throw new Error(`2925邮箱中未找到验证码: targetEmail=${email}`);
        },
    };
}

