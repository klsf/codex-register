import {readFileSync} from "node:fs";
import path from "node:path";

export type MailProviderName = "gmail" | "hotmail" | "cloudflare" | "mailnest";

interface AppConfigFile {
    provider?: unknown;
    defaultPassword?: unknown;
    loopDelayMs?: unknown;
    gmailAccessToken?: unknown;
    gmailEmailAddress?: unknown;
    cloudflareEmailDomain?: unknown;
    cloudflareApiBaseUrl?: unknown;
    cloudflareApiKey?: unknown;
    mailNestApiKey?: unknown,
    mailNestProjectCode?: unknown,
    defaultProxyUrl?: unknown;
    cliproxyApiAutoUploadAuth?: unknown;
    cliproxyApiBaseUrl?: unknown;
    cliproxyApiManagementKey?: unknown;
}

export interface AppConfig {
    provider: MailProviderName;
    defaultPassword: string;
    loopDelayMs: number;
    gmailAccessToken: string;
    gmailEmailAddress: string;
    cloudflareEmailDomain: string;
    cloudflareApiBaseUrl: string;
    cloudflareApiKey: string;
    mailNestApiKey: string;
    mailNestProjectCode: string;
    defaultProxyUrl: string;
    cliproxyApiAutoUploadAuth: boolean;
    cliproxyApiBaseUrl: string;
    cliproxyApiManagementKey: string;
}

const DEFAULT_CONFIG: AppConfig = {
    provider: "cloudflare",
    defaultPassword: "kuaileshifu88",
    loopDelayMs: 120000,
    gmailAccessToken: "",
    gmailEmailAddress: "",
    cloudflareEmailDomain: "",
    cloudflareApiBaseUrl: "",
    cloudflareApiKey: "",
    defaultProxyUrl: "http://127.0.0.1:10808",
    mailNestApiKey: "",
    mailNestProjectCode: "",
    cliproxyApiAutoUploadAuth: false,
    cliproxyApiBaseUrl: "http://localhost:8317",
    cliproxyApiManagementKey: "",
};

function normalizeNumber(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    return value;
}

function normalizeProvider(value: unknown): MailProviderName {
    if (value === "gmail" || value === "hotmail" || value === "cloudflare" || value === "mailnest") {
        return value;
    }
    return DEFAULT_CONFIG.provider;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["true", "1", "yes", "on"].includes(normalized)) {
            return true;
        }
        if (["false", "0", "no", "off"].includes(normalized)) {
            return false;
        }
    }
    return fallback;
}

function loadConfig(): AppConfig {
    const configPath = path.resolve(process.cwd(), "config.json");
    let raw: string;
    try {
        raw = readFileSync(configPath, "utf8");
    } catch {
        throw new Error("未找到 config.json，请先复制 config.example.json 为 config.json 并按需修改配置");
    }

    const parsed = JSON.parse(raw) as AppConfigFile;
    return {
        provider: normalizeProvider(parsed.provider),
        defaultPassword:
            typeof parsed.defaultPassword === "string" && parsed.defaultPassword.trim()
                ? parsed.defaultPassword
                : DEFAULT_CONFIG.defaultPassword,
        loopDelayMs: normalizeNumber(parsed.loopDelayMs, DEFAULT_CONFIG.loopDelayMs),
        gmailAccessToken:
            typeof parsed.gmailAccessToken === "string"
                ? parsed.gmailAccessToken.trim()
                : DEFAULT_CONFIG.gmailAccessToken,
        gmailEmailAddress:
            typeof parsed.gmailEmailAddress === "string"
                ? parsed.gmailEmailAddress.trim()
                : DEFAULT_CONFIG.gmailEmailAddress,
        cloudflareEmailDomain:
            typeof parsed.cloudflareEmailDomain === "string" && parsed.cloudflareEmailDomain.trim()
                ? parsed.cloudflareEmailDomain.trim()
                : DEFAULT_CONFIG.cloudflareEmailDomain,
        cloudflareApiBaseUrl:
            typeof parsed.cloudflareApiBaseUrl === "string"
                ? parsed.cloudflareApiBaseUrl.trim()
                : DEFAULT_CONFIG.cloudflareApiBaseUrl,
        cloudflareApiKey:
            typeof parsed.cloudflareApiKey === "string"
                ? parsed.cloudflareApiKey.trim()
                : DEFAULT_CONFIG.cloudflareApiKey,
        mailNestApiKey:
            typeof parsed.mailNestApiKey === "string"
                ? parsed.mailNestApiKey.trim()
                : DEFAULT_CONFIG.mailNestApiKey,
        mailNestProjectCode:
            typeof parsed.mailNestProjectCode === "string"
            ? parsed.mailNestProjectCode.trim()
            : DEFAULT_CONFIG.mailNestProjectCode,
        defaultProxyUrl:
            typeof parsed.defaultProxyUrl === "string"
                ? parsed.defaultProxyUrl.trim()
                : DEFAULT_CONFIG.defaultProxyUrl,
        cliproxyApiAutoUploadAuth: normalizeBoolean(
            parsed.cliproxyApiAutoUploadAuth,
            DEFAULT_CONFIG.cliproxyApiAutoUploadAuth,
        ),
        cliproxyApiBaseUrl:
            typeof parsed.cliproxyApiBaseUrl === "string" && parsed.cliproxyApiBaseUrl.trim()
                ? parsed.cliproxyApiBaseUrl.trim()
                : DEFAULT_CONFIG.cliproxyApiBaseUrl,
        cliproxyApiManagementKey:
            typeof parsed.cliproxyApiManagementKey === "string"
                ? parsed.cliproxyApiManagementKey.trim()
                : DEFAULT_CONFIG.cliproxyApiManagementKey,
    };
}

export const appConfig = loadConfig();
