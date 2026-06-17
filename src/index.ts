import {appConfig} from "./config.js";
import {hasFlag, readPositiveIntArg} from "./cli-args.js";
import {generateRandomDeviceProfile} from "./device-profile.js";
import {OpenAIClient} from "./openai.js";

async function runOnce(): Promise<void> {
    const directSignupAuth = hasFlag("--sign");
    const saveAccessToken = hasFlag("--at");
    const deviceProfile = generateRandomDeviceProfile();
    if (directSignupAuth) {
        const client = new OpenAIClient({
            password: appConfig.defaultPassword,
            deviceProfile,
            signupScreenHint: "signup",
        });
        const result = await client.authRegisterAndAuthorizeHTTP();
        console.log(
            `[✅️授权成功] 邮箱：${client.email} 密码：${appConfig.defaultPassword} 授权文件：${result.authFile ?? ""}`,
        );
        return;
    }

    const registerClient = new OpenAIClient({
        password: appConfig.defaultPassword,
        deviceProfile,
    });
    await registerClient.authRegisterHTTP();

    if (saveAccessToken) {
        const accessToken = await registerClient.getChatGPTAccessToken();
        const accessTokenFile = await registerClient.saveChatGPTAccessToken(accessToken);
        console.log(`[✅️注册成功] 邮箱：${registerClient.email} 密码：${appConfig.defaultPassword}`);
        console.log(`[access_token_file] ${accessTokenFile}`);
        console.log(`[access_token] ${accessToken}`);
        return;
    }

    const loginClient = new OpenAIClient({
        email: registerClient.email,
        password: appConfig.defaultPassword,
        deviceProfile,
    });
    const result = await loginClient.authLoginHTTP();
    console.log(
        `[✅️授权成功] 邮箱：${loginClient.email} 密码：${appConfig.defaultPassword} 授权文件：${result.authFile ?? ""}`,
    );
}

async function main() {
    let round = 0;
    let successCount = 0;
    let failCount = 0;
    const maxRounds = readPositiveIntArg("--n");

    while (!maxRounds || round < maxRounds) {
        round += 1;
        console.log(
            `第 ${round} 轮开始: 成功=${successCount} 失败=${failCount} 模式=自动`,
        );
        try {
            await runOnce();
            successCount += 1;
        } catch (error) {
            failCount += 1;
            console.error(`[❌️授权失败]`, error);
        }

        if (appConfig.loopDelayMs > 0) {
            console.log(`[延迟] 轮次间等待 ${appConfig.loopDelayMs}ms`);
            await new Promise((resolve) => setTimeout(resolve, appConfig.loopDelayMs));
        }
    }

    console.log(
        `自动模式结束: 已执行=${round} 成功=${successCount} 失败=${failCount}`,
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
