export {DEFAULT_USER_AGENT} from "./device-profile.js";

export const AUTH_BASE_URL = "https://auth.openai.com";

export const AUTH_AUTHORIZE_CONTINUE_URL =
  "https://auth.openai.com/api/accounts/authorize/continue";

export const AUTH_PASSWORD_VERIFY_URL =
  "https://auth.openai.com/api/accounts/password/verify";

export const AUTH_EMAIL_OTP_VALIDATE_URL =
  "https://auth.openai.com/api/accounts/email-otp/validate";

export const AUTH_WORKSPACE_SELECT_URL =
  "https://auth.openai.com/api/accounts/workspace/select";

export const AUTH_REGISTER_URL =
  "https://auth.openai.com/api/accounts/user/register";

export const AUTH_EMAIL_OTP_SEND_URL =
  "https://auth.openai.com/api/accounts/email-otp/send";

export const AUTH_OAUTH_TOKEN_URLS = [
  "https://auth.openai.com/api/oauth/oauth2/token",
  "https://auth.openai.com/oauth/token",
] as const;

export const DEFAULT_REDIRECT_URI = "http://localhost:1455/auth/callback";

export const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const CHATGPT_BASE_URL = "https://chatgpt.com";
