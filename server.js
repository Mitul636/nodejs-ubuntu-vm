import { api } from "encore.dev/api";
import { Service } from "encore.dev/service";
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

// Initialize the 24/7 service infrastructure wrapper
const containerEngine = new Service("container-engine");

// Runtime Paths mapped inside Encore workspace container
const __dirname = path.resolve();
const BIN_DIR = path.join(__dirname, 'bin');
const PROOT_PATH = path.join(BIN_DIR, 'proot');
const ROOTFS_DIR = path.join(__dirname, 'ubuntu-22-rootfs');
const ARCHIVE_PATH = path.join(__dirname, 'ubuntu-rootfs.tar.gz');

const PROOT_SOURCES = [
    'https://proot.gitlab.io/proot/bin/proot',
    'https://raw.githubusercontent.com/proot-me/proot-static-build/master/proot-x86_64'
];
const ROOTFS_SOURCES = [
    'https://cdimage.ubuntu.com/ubuntu-base/releases/jammy/release/ubuntu-base-22.04-base-amd64.tar.gz'
];

function log(status: string, msg: string) {
    const symbols: Record<string, string> = { info: '💡', success: '✅', warning: '⚠️', error: '🚨' };
    console.log(`[ImGunpoint] ${symbols[status] || '⚙️'} ${msg}`);
}

// Network Downloader
function downloadFile(urls: string[], outputPath: string, index = 0): Promise<void> {
    return new Promise((resolve, reject) => {
        if (index >= urls.length) {
            return reject(new Error('All download sources exhausted. Connection failed.'));
        }
        const url = urls[index];
        log('info', `Using Route #${index + 1}/${urls.length}: ${url}`);
        const client = url.startsWith('https') ? https : http;

        client.get(url, (response) => {
            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                log('info', `Following Redirect Matrix...`);
                return downloadFile([response.headers.location, ...urls.slice(index + 1)], outputPath, 0).then(resolve).catch(reject);
            }
            if (response.statusCode !== 200) {
                log('warning', `Route dropped with status: ${response.statusCode}`);
                return downloadFile(urls, outputPath, index + 1).then(resolve).catch(reject);
            }
            const fileStream = fs.createWriteStream(outputPath);
            response.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close();
                log('success', `Download verified and written to disk.`);
                resolve();
            });
        }).on('error', (err) => {
            log('warning', `Network exception caught: ${err.message}`);
            return downloadFile(urls, outputPath, index + 1).then(resolve).catch(reject);
        });
    });
}

// 🧱 Boot hook: Runs automatically once before serving traffic to set up dependencies
async function initializeEnvironment() {
    log('info', 'Booting core system matrix...');
    if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

    if (!fs.existsSync(PROOT_PATH)) {
        log('info', 'PRoot native core not found. Fetching runtime...');
        await downloadFile(PROOT_SOURCES, PROOT_PATH);
        fs.chmodSync(PROOT_PATH, 0o755); 
        log('success', 'PRoot execution flags established.');
    }

    const bashCheckPath = path.join(ROOTFS_DIR, 'bin', 'bash');
    if (fs.existsSync(ROOTFS_DIR) && !fs.existsSync(bashCheckPath)) {
        log('warning', 'Incomplete RootFS detected. Purging directory...');
        fs.rmSync(ROOTFS_DIR, { recursive: true, force: true });
    }

    if (!fs.existsSync(ROOTFS_DIR)) fs.mkdirSync(ROOTFS_DIR, { recursive: true });

    if (!fs.existsSync(bashCheckPath)) {
        log('info', 'Ubuntu 22.04 user-space image missing. Fetching RootFS Tarball...');
        await downloadFile(ROOTFS_SOURCES, ARCHIVE_PATH);
        log('info', 'Decompressing Ubuntu 22.04 core images...');
        await new Promise<void>((resolve, reject) => {
            const extract = spawn('tar', ['-xzf', ARCHIVE_PATH, '-C', ROOTFS_DIR]);
            extract.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`Tar sub-process exited with code: ${code}`));
            });
        });
        try { fs.unlinkSync(ARCHIVE_PATH); } catch(e) {}
        log('success', 'Ubuntu 22.04 ecosystem extracted completely.');
    }
}

// Trigger initialization process safely inside our service script environment
initializeEnvironment().catch(err => log('error', `Workspace prep failed: ${err.message}`));

// 🌐 Static Hosting Definition: Serves your frontend interface at the home route
export const serveFrontend = api.static({
    expose: true,
    path: "/",
    dir: "./public",
});

// Define type-safe payloads for our streaming API
interface InboundMessage {
    type: "cmd" | "action";
    payload: string;
}

interface OutboundMessage {
    outputChunk?: string;
    actionType?: string;
}

// 🖥️ Bi-directional live endpoint streaming interface replacing standard WebSockets
export const connectTerminalStream = api.streamInOut(
    { expose: true, path: "/terminal/stream" },
    async (stream) => {
        log('info', 'Web interface synchronized to backend terminal stream via Encore gateway.');

        try {
            const etcDir = path.join(ROOTFS_DIR, 'etc');
            if (!fs.existsSync(etcDir)) fs.mkdirSync(etcDir, { recursive: true });
            fs.writeFileSync(path.join(etcDir, 'resolv.conf'), 'nameserver 8.8.8.8\nnameserver 8.8.4.4\n');
        } catch (dnsErr: any) {
            log('warning', `Failed DNS link binding optimization: ${dnsErr.message}`);
        }

        const args = ['-r', ROOTFS_DIR, '-0', '-w', '/', '-b', '/proc', '-b', '/dev', '-b', '/sys', '/bin/bash', '--login'];

        let bashEnv = spawn(PROOT_PATH, args, {
            env: { 
                ...process.env, 
                TERM: 'xterm-color', 
                HOME: '/root',
                PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
            }
        });

        const bindStreams = (proc: any) => {
            proc.stdout.on('data', async (data: Buffer) => {
                try { await stream.send({ outputChunk: data.toString() }); } catch(e){}
            });
            proc.stderr.on('data', async (data: Buffer) => {
                try { await stream.send({ outputChunk: data.toString() }); } catch(e){}
            });
            proc.on('close', async (code: number) => {
                try { await stream.send({ outputChunk: `\n\x1B[31m[Process exited with status framework code: ${code}]\x1B[0m\n` }); } catch(e){}
            });
        };

        bindStreams(bashEnv);
        await stream.send({ outputChunk: "\x1B[92mEnvironment booted successfully. Upgraded to Ubuntu 22.04 LTS Framework inside Encore Cloud.\x1B[0m\n\n" });

        try {
            for await (const msg of stream) {
                const parsed = msg as InboundMessage;
                if (parsed.type === 'cmd') {
                    if (bashEnv.stdin.writable) bashEnv.stdin.write(parsed.payload);
                } else if (parsed.type === 'action') {
                    if (parsed.payload === 'SIGINT') {
                        log('info', 'Manual override (Ctrl+C) triggered.');
                        bashEnv.kill('SIGINT');
                    } else if (parsed.payload === 'RESTART') {
                        log('warning', 'Cold reboot requested...');
                        bashEnv.kill();
                        bashEnv = spawn(PROOT_PATH, args, {
                            env: { ...process.env, TERM: 'xterm-color', HOME: '/root', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }
                        });
                        bindStreams(bashEnv);
                        await stream.send({ actionType: 'sys_reload' });
                    }
                }
            }
        } catch (err) {
            log('info', 'Streaming reader broke or client disconnected.');
        } finally {
            log('info', 'Disposing child subsystem trees.');
            bashEnv.kill();
        }
    }
);
