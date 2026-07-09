import {appConfig} from "../config.js";
import {Agent, Dispatcher, ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit} from "undici";


interface MailNestMailItem {
  email: string;
  code_match: string;
}

interface MailNestItems {
  code?: string;
  data: MailNestMailItem[];
}

const MAILNEST_POLL_ATTEMPTS = 12;
const MAILNEST_POLL_INTERVAL_MS = 5000;

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

function ensureApiKeyConfigured(): string {
  const apiKey = String(appConfig.mailNestApiKey ?? "").trim();
  if (!apiKey) {
    throw new Error("MailNestApiKey 未配置，请先在 https://mailnest.top/account 页面获取");
  }
  return apiKey;
}

function projectCodeApiKeyConfigured(): string {
  return String(appConfig.mailNestProjectCode ?? "").trim();
}


async function mailNestFetch(input: string | URL, init = {}) {
  return undiciFetch(input, {
    ...init,
    dispatcher: buildDispatcher(),
  } satisfies UndiciRequestInit);
}


async function fetchEmail(): Promise<string> {
  const apiKey = ensureApiKeyConfigured();
  const code = projectCodeApiKeyConfigured();
  let response;
  if (code.length === 0) {
    console.log('未配置项目代码 购买独占邮箱')
    response = await mailNestFetch(new URL(`https://mailnest.top/api/v1/email/exclusive/buy`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      body: JSON.stringify({
        count: 1,
      })
    });
  } else {
    console.log('配置项目代码 购买临时邮箱')
    response = await mailNestFetch(new URL(`https://mailnest.top/api/v1/email/temporary/buy`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      body: JSON.stringify({
        project_code: code,
        count: 1,
      })
    });
  }
  const payload = await response.json() as MailNestItems;
  console.log(payload);
  if (payload.code != '00000') {
    throw new Error(`mailNest 邮箱请求失败: ${response.status} body=${await response.text()}`);
  }

  if (!Array.isArray(payload?.data)) {
    throw new Error(`mailNest 邮箱返回格式异常: ${JSON.stringify(payload)}`);
  }
  if (payload.data.length == 0) {
    throw new Error(`mailNest 没有获取到邮箱: ${JSON.stringify(payload)}`);
  }
  return payload.data[0].email;
}


async function receive(email: string): Promise<string> {
  const apiKey = ensureApiKeyConfigured();
  const response = await mailNestFetch(new URL(` https://mailnest.top/api/v1/email/receive`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    body: JSON.stringify({
      email: email,
    })
  });
  const payload = await response.json() as MailNestItems;
  console.log(payload)
  if (payload.code != '00000') {
    throw new Error(`mailNest 邮箱请求失败: ${response.status} body=${await response.text()}`);
  }
  if (payload.data.length == 0) {
    return ''
  }
  return payload.data[0].code_match;
}


export function createMailNestProvider() {
  return {
    async getEmailAddress() {
      return fetchEmail()
    },
    async getEmailVerificationCode(email: string) {
      await new Promise((resolve) => setTimeout(resolve, MAILNEST_POLL_INTERVAL_MS));
      ensureApiKeyConfigured();
      for (let attempt = 1; attempt <= MAILNEST_POLL_ATTEMPTS; attempt += 1) {
        const code = await receive(email);
        if (code.length > 0) {
          return code;
        }
        if (attempt < MAILNEST_POLL_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, MAILNEST_POLL_INTERVAL_MS));
        }
      }
      throw new Error(`mailNest 邮箱中未找到验证码: targetEmail=${email}`);
    },
  };
}
