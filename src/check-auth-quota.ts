import {createRequire} from "node:module";
import {mkdir, readdir, readFile, rename, writeFile} from "node:fs/promises";
import path from "node:path";
import {appConfig} from "./config.js";
import {AUTH_OAUTH_TOKEN_URLS, DEFAULT_CLIENT_ID, DEFAULT_USER_AGENT} from "./constants.js";

interface AuthRecord {
    access_token?: string;
    account_id?: string;
    disabled?: boolean;
    email?: string;
    expired?: string;
    id_token?: string;
    last_refresh?: string;
    refresh_token?: string;
    type?: string;
    websockets?: boolean;
}

interface JwtClaims {
    email?: string;
    ["https://api.openai.com/auth"]?: {
        chatgpt_account_id?: string;
        chatgpt_plan_type?: string;
    };
}

interface ProbeResponse {
    status: number;
    body: string;
}

interface OAuthTokenResponse {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
}

interface UsageWindow {
    used_percent?: number;
    reset_after_seconds?: number;
}

interface UsagePayload {
    plan_type?: string;
    rate_limit?: {
        limit_reached?: boolean;
        primary_window?: UsageWindow;
        secondary_window?: UsageWindow;
    };

    [key: string]: unknown;
}

interface AuthSummary {
    file: string;
    email: string;
    plan: string;
    status: string;
    ok: boolean;
    used: string;
    remaining: string;
    reset: string;
    limitReached: string;
    expires: string;
    note: string;
    rawStatus: number;
    rawBody: string;
    movedTo401: boolean;
}

const DEFAULT_AUTH_DIR = path.resolve(process.cwd(), "auth");
const REQUEST_TIMEOUT_MS = 15000;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const require = createRequire(import.meta.url);
const {
    fetch: undiciFetch,
    Agent,
    ProxyAgent,
}: {
    fetch: typeof fetch;
    Agent: new (options?: { connect?: { rejectUnauthorized?: boolean } }) => unknown;
    ProxyAgent: new (options: {
        uri: string;
        requestTls?: { rejectUnauthorized?: boolean };
    }) => unknown;
} = require("undici");

function readFlagValue(flag: string): string {
    const index = process.argv.indexOf(flag);
    if (index === -1) {
        return "";
    }
    return process.argv[index + 1] ?? "";
}

function hasFlag(flag: string): boolean {
    return process.argv.includes(flag);
}

function maskPath(filePath: string): string {
    return path.relative(process.cwd(), filePath) || filePath;
}

async function collectAuthFiles(rootDir: string): Promise<string[]> {
    const entries = await readdir(rootDir, {withFileTypes: true});
    const files: string[] = [];
    for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
            files.push(path.join(rootDir, entry.name));
        }
    }
    files.sort((left, right) => left.localeCompare(right));
    return files;
}

async function loadAuthRecord(filePath: string): Promise<AuthRecord> {
    return JSON.parse(await readFile(filePath, "utf8")) as AuthRecord;
}

function decodeJwtClaims(token: string | undefined): JwtClaims | null {
    if (!token) {
        return null;
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
        return null;
    }
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
    try {
        return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as JwtClaims;
    } catch {
        return null;
    }
}

function parseJson<T>(raw: string): T | null {
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

function getProxyUrl(): string {
    return readFlagValue("--proxy").trim() || appConfig.defaultProxyUrl;
}

function buildDispatcher(): unknown {
    const proxyUrl = getProxyUrl();
    return proxyUrl
        ? new ProxyAgent({
            uri: proxyUrl,
            requestTls: {rejectUnauthorized: false},
        })
        : new Agent({
            connect: {rejectUnauthorized: false},
        });
}

function extractMessage(rawBody: string): string {
    const payload = parseJson<Record<string, unknown>>(rawBody);
    const errorObject =
        payload?.error && typeof payload.error === "object"
            ? payload.error as Record<string, unknown>
            : null;
    return String(
        errorObject?.message ??
        payload?.message ??
        payload?.detail ??
        errorObject?.code ??
        payload?.error_description ??
        payload?.error ??
        rawBody,
    );
}

function shouldMoveTo401(message: string): boolean {
    return message.toLowerCase().includes("deactivated");
}

function formatPercent(value: number | undefined): string {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return "-";
    }
    return `${value.toFixed(2)}%`;
}

function formatRemaining(value: number | undefined): string {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return "-";
    }
    return `${Math.max(0, 100 - value).toFixed(2)}%`;
}

function formatResetAt(seconds: number | undefined): string {
    if (typeof seconds !== "number" || seconds <= 0 || Number.isNaN(seconds)) {
        return "-";
    }
    const date = new Date(Date.now() + seconds * 1000);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    const second = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

async function sendUsageProbe(accessToken: string, accountId: string): Promise<ProbeResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);
    const dispatcher = buildDispatcher();

    try {
        const response = await undiciFetch(USAGE_URL, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/json",
                "User-Agent": DEFAULT_USER_AGENT,
                Origin: "https://chatgpt.com",
                Referer: "https://chatgpt.com/",
                ...(accountId ? {"Chatgpt-Account-Id": accountId} : {}),
            },
            signal: controller.signal,
            dispatcher,
        } as RequestInit & { dispatcher: unknown });
        return {
            status: response.status,
            body: await response.text(),
        };
    } catch (error) {
        return {
            status: 0,
            body: String(error),
        };
    } finally {
        clearTimeout(timer);
    }
}

function normalizeRefreshedAuthRecord(existing: AuthRecord, payload: OAuthTokenResponse): AuthRecord {
    if (!payload.access_token) {
        throw new Error(`refresh 响应缺少 access_token: ${JSON.stringify(payload)}`);
    }
    if (!payload.refresh_token) {
        throw new Error(`refresh 响应缺少 refresh_token: ${JSON.stringify(payload)}`);
    }
    if (!payload.id_token) {
        throw new Error(`refresh 响应缺少 id_token: ${JSON.stringify(payload)}`);
    }

    const accessClaims = decodeJwtClaims(payload.access_token);
    const idClaims = decodeJwtClaims(payload.id_token);
    const accountId =
        accessClaims?.["https://api.openai.com/auth"]?.chatgpt_account_id?.trim() ||
        idClaims?.["https://api.openai.com/auth"]?.chatgpt_account_id?.trim() ||
        existing.account_id?.trim() ||
        "";
    const email =
        existing.email?.trim() ||
        idClaims?.email?.trim() ||
        accessClaims?.email?.trim() ||
        "";
    const exp = typeof payload.expires_in === "number" && payload.expires_in > 0
        ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
        : existing.expired?.trim() || "-";

    return {
        ...existing,
        access_token: payload.access_token,
        account_id: accountId,
        disabled: false,
        email,
        expired: exp,
        id_token: payload.id_token,
        last_refresh: new Date().toISOString(),
        refresh_token: payload.refresh_token,
        type: existing.type ?? "codex",
        websockets: existing.websockets ?? false,
    };
}

async function refreshAccessToken(
    record: AuthRecord,
): Promise<{ record?: AuthRecord; error?: string; status?: number }> {
    if (!record.refresh_token) {
        return {error: "缺少 refresh_token"};
    }

    let lastError = "";
    let lastStatus = 0;
    for (const tokenURL of AUTH_OAUTH_TOKEN_URLS) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);
        try {
            const response = await undiciFetch(tokenURL, {
                method: "POST",
                headers: {
                    accept: "application/json",
                    "content-type": "application/x-www-form-urlencoded",
                    "user-agent": DEFAULT_USER_AGENT,
                },
                body: new URLSearchParams({
                    grant_type: "refresh_token",
                    client_id: DEFAULT_CLIENT_ID,
                    refresh_token: record.refresh_token,
                }),
                signal: controller.signal,
                dispatcher: buildDispatcher(),
            } as RequestInit & { dispatcher: unknown });

            const rawBody = await response.text();
            if (!response.ok) {
                lastStatus = response.status;
                lastError = extractMessage(rawBody);
                continue;
            }

            const payload = parseJson<OAuthTokenResponse>(rawBody);
            if (!payload) {
                lastError = "refresh 响应不是合法 JSON";
                continue;
            }

            return {
                record: normalizeRefreshedAuthRecord(record, payload),
            };
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        } finally {
            clearTimeout(timer);
        }
    }

    return {error: lastError || "refresh 失败", status: lastStatus || undefined};
}

async function saveAuthRecord(filePath: string, record: AuthRecord): Promise<void> {
    await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, maxLength - 3)}...`;
}

function formatCell(value: string, width: number): string {
    return value.padEnd(width, " ");
}

function printTable(rows: AuthSummary[]): void {
    const headers = {
        file: "file",
        email: "email",
        plan: "plan",
        status: "status",
        used: "used",
        remaining: "remaining",
        reset: "reset",
        limitReached: "limit_reached",
        expires: "expires",
        note: "note",
    };

    const widths = {
        file: Math.min(42, Math.max(headers.file.length, ...rows.map((row) => row.file.length))),
        email: Math.min(32, Math.max(headers.email.length, ...rows.map((row) => row.email.length))),
        plan: Math.max(headers.plan.length, ...rows.map((row) => row.plan.length)),
        status: Math.max(headers.status.length, ...rows.map((row) => row.status.length)),
        used: Math.max(headers.used.length, ...rows.map((row) => row.used.length)),
        remaining: Math.max(headers.remaining.length, ...rows.map((row) => row.remaining.length)),
        reset: Math.min(32, Math.max(headers.reset.length, ...rows.map((row) => row.reset.length))),
        limitReached: Math.max(
            headers.limitReached.length,
            ...rows.map((row) => row.limitReached.length),
        ),
        expires: Math.max(headers.expires.length, ...rows.map((row) => row.expires.length)),
        note: Math.min(60, Math.max(headers.note.length, ...rows.map((row) => row.note.length))),
    };

    const headerLine = [
        formatCell(headers.file, widths.file),
        formatCell(headers.email, widths.email),
        formatCell(headers.plan, widths.plan),
        formatCell(headers.status, widths.status),
        formatCell(headers.used, widths.used),
        formatCell(headers.remaining, widths.remaining),
        formatCell(headers.reset, widths.reset),
        formatCell(headers.limitReached, widths.limitReached),
        formatCell(headers.expires, widths.expires),
        formatCell(headers.note, widths.note),
    ].join("  ");

    console.log(headerLine);
    console.log("-".repeat(headerLine.length));
    for (const row of rows) {
        console.log(
            [
                formatCell(truncate(row.file, widths.file), widths.file),
                formatCell(truncate(row.email, widths.email), widths.email),
                formatCell(truncate(row.plan, widths.plan), widths.plan),
                formatCell(truncate(row.status, widths.status), widths.status),
                formatCell(truncate(row.used, widths.used), widths.used),
                formatCell(truncate(row.remaining, widths.remaining), widths.remaining),
                formatCell(truncate(row.reset, widths.reset), widths.reset),
                formatCell(truncate(row.limitReached, widths.limitReached), widths.limitReached),
                formatCell(truncate(row.expires, widths.expires), widths.expires),
                formatCell(truncate(row.note, widths.note), widths.note),
            ].join("  "),
        );
    }
}

function printCheckLine(row: AuthSummary): void {
    if (!row.ok) {
        console.log(`[❌️]${row.email}-${row.note || "未知错误"}`);
        return;
    }

    const extra = row.movedTo401 ? " 已移除" : "";
    const remaining = row.remaining === "-" ? "N/A" : row.remaining;
    const reset = row.reset === "-" ? "N/A" : row.reset;
    console.log(`[✅️][${row.plan}][${remaining}]${row.email}-${reset}${extra}`);
}

async function moveTo401Dir(filePath: string): Promise<boolean> {
    const parentDir = path.dirname(filePath);
    const targetDir = path.join(parentDir, "401");
    const targetPath = path.join(targetDir, path.basename(filePath));
    await mkdir(targetDir, {recursive: true});
    await rename(filePath, targetPath);
    return true;
}

async function summarizeAuth(filePath: string, forceRefresh: boolean): Promise<AuthSummary> {
    let record = await loadAuthRecord(filePath);
    const claims = decodeJwtClaims(record.id_token ?? record.access_token);
    const email = record.email?.trim() || claims?.email?.trim() || path.basename(filePath);
    const localPlan = claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type?.trim() || "-";

    if (!record.access_token) {
        return {
            file: maskPath(filePath),
            email,
            plan: localPlan,
            status: "invalid",
            ok: false,
            used: "-",
            remaining: "-",
            reset: "-",
            limitReached: "-",
            expires: record.expired?.trim() || "-",
            note: "缺少 access_token",
            rawStatus: 0,
            rawBody: "missing access_token",
            movedTo401: false,
        };
    }

    let movedTo401 = false;
    let probe: ProbeResponse;
    let message = "";

    if (forceRefresh) {
        const refreshed = await refreshAccessToken(record);
        if (refreshed.record) {
            record = refreshed.record;
            await saveAuthRecord(filePath, record);
            probe = await sendUsageProbe(record.access_token ?? "", record.account_id?.trim() || "");
            message = extractMessage(probe.body);
        } else {
            probe = {
                status: refreshed.status ?? 0,
                body: refreshed.error || "refresh 失败",
            };
            message = refreshed.error || "refresh 失败";
        }
    } else {
        probe = await sendUsageProbe(record.access_token, record.account_id?.trim() || "");
        message = extractMessage(probe.body);
    }

    if (probe.status === 401) {
        if (shouldMoveTo401(message)) {
            try {
                movedTo401 = await moveTo401Dir(filePath);
            } catch (error) {
                const moveMessage = error instanceof Error ? error.message : String(error);
                return {
                    file: maskPath(filePath),
                    email,
                    plan: localPlan,
                    status: "http_401",
                    ok: false,
                    used: "-",
                    remaining: "-",
                    reset: "-",
                    limitReached: "-",
                    expires: record.expired?.trim() || "-",
                    note: `移动401目录失败: ${truncate(moveMessage, 40)}`,
                    rawStatus: probe.status,
                    rawBody: probe.body,
                    movedTo401: false,
                };
            }
        } else {
            const refreshed = await refreshAccessToken(record);
            if (refreshed.record) {
                record = refreshed.record;
                await saveAuthRecord(filePath, record);
                probe = await sendUsageProbe(record.access_token ?? "", record.account_id?.trim() || "");
                message = extractMessage(probe.body);
            } else {
                message = refreshed.error || message;
                if (refreshed.status === 401) {
                    try {
                        movedTo401 = await moveTo401Dir(filePath);
                    } catch (error) {
                        const moveMessage = error instanceof Error ? error.message : String(error);
                        return {
                            file: maskPath(filePath),
                            email,
                            plan: localPlan,
                            status: "http_401",
                            ok: false,
                            used: "-",
                            remaining: "-",
                            reset: "-",
                            limitReached: "-",
                            expires: record.expired?.trim() || "-",
                            note: `移动401目录失败: ${truncate(moveMessage, 40)}`,
                            rawStatus: probe.status,
                            rawBody: probe.body,
                            movedTo401: false,
                        };
                    }
                }
            }
        }
    }

    const payload = parseJson<UsagePayload>(probe.body);
    const primary = payload?.rate_limit?.primary_window;
    const note =
        probe.status === 200
            ? "请求成功"
            : message;

    return {
        file: maskPath(filePath),
        email,
        plan: payload?.plan_type?.trim() || localPlan,
        status: probe.status === 200 ? "ok" : `http_${probe.status}`,
        ok: probe.status === 200,
        used: formatPercent(primary?.used_percent),
        remaining: formatRemaining(primary?.used_percent),
        reset: formatResetAt(primary?.reset_after_seconds),
        limitReached:
            typeof payload?.rate_limit?.limit_reached === "boolean"
                ? String(payload.rate_limit.limit_reached)
                : "-",
        expires: record.expired?.trim() || "-",
        note,
        rawStatus: probe.status,
        rawBody: probe.body,
        movedTo401,
    };
}

async function main(): Promise<void> {
    const authDir = path.resolve(readFlagValue("--dir").trim() || DEFAULT_AUTH_DIR);
    const limitArg = Number.parseInt(readFlagValue("--limit").trim(), 10);
    const forceRefresh = hasFlag("--refresh");
    const files = await collectAuthFiles(authDir);
    const targetFiles =
        Number.isFinite(limitArg) && limitArg > 0 ? files.slice(0, limitArg) : files;

    if (!targetFiles.length) {
        throw new Error(`未在目录中找到授权文件: ${authDir}`);
    }

    console.log(`准备检查 ${targetFiles.length} 个 auth 文件: ${authDir}${forceRefresh ? " (强制刷新 token)" : ""}`);

    const rows: AuthSummary[] = [];
    for (let index = 0; index < targetFiles.length; index += 1) {
        const filePath = targetFiles[index];
        console.log(`[${index + 1}/${targetFiles.length}] 检查 ${maskPath(filePath)}`);
        const row = await summarizeAuth(filePath, forceRefresh);
        rows.push(row);
        printCheckLine(row);
        if (hasFlag("--verbose")) {
            console.log(`RAW_STATUS: ${row.rawStatus}`);
            console.log("RAW_BODY_START");
            console.log(row.rawBody);
            console.log("RAW_BODY_END");
        }
    }
    const availableCount = rows.filter((row) => row.ok).length;
    console.log(`剩余可用：${availableCount}/${rows.length}`);
    if (hasFlag("--table")) {
        printTable(rows);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
