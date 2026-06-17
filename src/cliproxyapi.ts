import {appConfig} from "./config.js";
import type {SavedAuthRecord} from "./openai.js";

function normalizeBaseUrl(value: string): string {
    return String(value ?? "").trim().replace(/\/+$/, "");
}

function getCLIProxyAPIConfig(): { baseUrl: string; managementKey: string } {
    const baseUrl = normalizeBaseUrl(appConfig.cliproxyApiBaseUrl);
    const managementKey = String(appConfig.cliproxyApiManagementKey ?? "").trim();
    if (!baseUrl) {
        throw new Error("cliproxyApiBaseUrl 未配置");
    }
    if (!managementKey) {
        throw new Error("cliproxyApiManagementKey 未配置");
    }
    return {
        baseUrl,
        managementKey,
    };
}

function createManagementHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
    const {managementKey} = getCLIProxyAPIConfig();
    return {
        Authorization: `Bearer ${managementKey}`,
        Accept: "application/json",
        ...extraHeaders,
    };
}

export function shouldAutoUploadAuthToCLIProxyAPI(): boolean {
    return appConfig.cliproxyApiAutoUploadAuth;
}

async function saveAuthFileJsonObjectToCLIProxyAPI(
    fileName: string,
    record: Record<string, unknown>,
): Promise<void> {
    const {baseUrl} = getCLIProxyAPIConfig();
    if (!fileName.toLowerCase().endsWith(".json")) {
        throw new Error(`上传到 CLIProxyAPI 的 auth 文件名必须是 .json: ${fileName}`);
    }

    const url = new URL(`${baseUrl}/v0/management/auth-files`);
    url.searchParams.set("name", fileName);

    const response = await fetch(url, {
        method: "POST",
        headers: createManagementHeaders({
            "Content-Type": "application/json",
        }),
        body: JSON.stringify(record, null, 2),
    });

    const rawBody = await response.text();
    if (!response.ok) {
        throw new Error(`CLIProxyAPI 上传 auth 失败: ${response.status} body=${rawBody}`);
    }
}

export async function uploadAuthFileToCLIProxyAPI(
    fileName: string,
    record: SavedAuthRecord,
): Promise<void> {
    if (!appConfig.cliproxyApiAutoUploadAuth) {
        return;
    }
    await saveAuthFileJsonObjectToCLIProxyAPI(fileName, record as unknown as Record<string, unknown>);
}
