/* Modified for IP Bot: publication preparation, configuration or security changes. See CHANGELOG.md. */
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const waitOn = require("wait-on");

require('./local-config.cjs').applyLocalEnvironment(path.resolve(__dirname, '..'));
const projectRoot = path.resolve(__dirname, "..");
// dev-server.cjs 在自己的进程里设置该变量（concurrently 的兄弟进程继承不到），这里补齐默认值，
// 否则 Electron 主进程会回退加载 dist/index.html 导致白屏
process.env.VITE_DEV_SERVER_URL ||= 'http://127.0.0.1:3344';
const serverUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:3344";
const mainBundle = path.join(projectRoot, "dist-electron", "main", "index.js");
const preloadBundle = path.join(projectRoot, "dist-electron", "preload", "index.js");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForSyntaxReady(filePath, label) {
    let lastSize = -1;

    for (let attempt = 0; attempt < 240; attempt++) {
        if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            if (stat.size > 0 && stat.size === lastSize) {
                const check = spawnSync(process.execPath, ["--check", filePath], {
                    stdio: "pipe",
                    encoding: "utf8",
                });
                if (check.status === 0) {
                    return;
                }
                process.stdout.write(
                    `[dev-electron] waiting for valid ${label} bundle: ${check.stderr || check.stdout}\n`
                );
            }
            lastSize = stat.size;
        }

        await sleep(250);
    }

    throw new Error(`[dev-electron] timed out waiting for ${label} bundle: ${filePath}`);
}

async function main() {
    await waitOn({
        resources: [serverUrl],
        timeout: 120000,
        validateStatus: status => status >= 200 && status < 400,
    });

    await waitForSyntaxReady(mainBundle, "main");
    await waitForSyntaxReady(preloadBundle, "preload");

    const electronBinary = require("electron");
    const child = spawn(electronBinary, ["."], {
        cwd: projectRoot,
        stdio: "inherit",
        env: process.env,
    });

    child.on("exit", code => {
        process.exit(code ?? 0);
    });
}

main().catch(error => {
    console.error("[dev-electron] failed to start Electron");
    console.error(error);
    process.exit(1);
});
