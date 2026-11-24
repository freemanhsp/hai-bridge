import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeApplicationConfig } from './app-config.mjs';
import { pairingIdentity, APPLICATION_SCHEMA } from './app-identity.mjs';
import { profileDirectory, defaultClientFile, validateClientDefault } from './profiles.mjs';
import { sshFile, writePrivateFile } from './config.mjs';
import { probeLocalPort } from './preflight.mjs';

const execute = promisify(execFile);
const UNCHECKED = ['remote_reachability', 'ssh_authentication', 'live_host_key', 'remote_forward_permissions',
  'tls_handshake', 'private_key_match', 'bridge_token_contents_and_authentication', 'hai_auth_contents_and_authentication',
  'hai_availability', 'model_inference', 'remote_release', 'VPN_sleep_resume'];

// Offline only: do not call loadApplicationConfig/loadPair, which read private material.
export async function inspectApplication({ role, file, profileDir, out } = {}, {
  files = fs, run = execute, probe = probeLocalPort, platform = process.platform,
  nodeVersion = process.versions.node, now = () => Date.now(),
} = {}) {
  if (!['publisher', 'client'].includes(role)) throw new Error('inspect-app requires --role publisher or client');
  const checks = [], notChecked = [...UNCHECKED];
  const add = (id, status, message, hint, details = {}) => checks.push({ id, status, message, ...(hint ? { hint } : {}), ...details });
  const finish = async () => {
    const report = { schema_version: 1, transport: 'app-tls', mode: 'offline', role,
      status: checks.some(c => c.status === 'fail') ? 'fail' : checks.some(c => c.status === 'warn') ? 'warn' : 'pass',
      checks, not_checked: notChecked };
    if (out !== undefined) {
      try { await writePrivateFile(sshFile(out), JSON.stringify(report, null, 2) + '\n'); }
      catch { throw new Error('Cannot create private diagnostic report; choose a new writable path. No existing report was overwritten.'); }
    }
    return report;
  };
  async function metadata(filename, id, { privateFile = false, limit = 1048576, directory = false } = {}) {
    try {
      const info = await files.lstat(filename);
      if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (!directory && info.size > limit)) throw new Error('unsafe_file');
      await files.access(filename, constants.R_OK);
      if (platform !== 'win32' && (info.mode & (privateFile ? 0o077 : 0o022))) {
        add(id, 'fail', '文件权限过宽；没有修改权限。', privateFile ? '限制为当前用户访问；不要打印或传递文件内容。' : '移除其他用户的写权限后再检查。');
        return undefined;
      }
      add(id, 'pass', directory ? '目录元数据可用。' : '文件元数据可用；未据此证明内容或认证有效。');
      return info;
    } catch {
      add(id, 'fail', '文件缺失、不可读、类型不符、符号链接或超过大小限制。', '检查配置相对路径及文件权限；不会自动创建或修复凭据。');
      return undefined;
    }
  }
  async function readPublic(filename, id, options = {}) {
    const limit = options.limit ?? 16384;
    const info = await metadata(filename, id + '.file', { ...options, limit });
    if (!info) return undefined;
    let handle;
    try {
      handle = await files.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const current = await handle.stat();
      if (!current.isFile() || current.size > limit || current.ino !== info.ino || current.dev !== info.dev) throw new Error('file_changed');
      if (platform !== 'win32' && (current.mode & (options.privateFile ? 0o077 : 0o022))) throw new Error('permissions_changed');
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > limit) throw new Error('oversize');
      return buffer.subarray(0, length).toString('utf8');
    } catch { add(id + '.read', 'fail', '无法安全读取公开材料或配置；不输出原始内容。'); }
    finally { await handle?.close(); }
  }
  const nodeOK = /^\d+\./.test(nodeVersion) && Number(nodeVersion.split('.')[0]) >= 22;
  add('node', nodeOK ? 'pass' : 'fail', nodeOK ? 'Node.js 22+ 可用。' : '需要 Node.js 22 或更新版本。');
  if (platform === 'win32') {
    add('windows_acl', 'warn', '未检查 Windows ACL；Unix 权限位不能证明访问限制。', '确认仅预期用户可读取凭据。');
    notChecked.push('windows_acl');
  }
  let configFile;
  try {
    if (file !== undefined) configFile = sshFile(file);
    else {
      const root = profileDirectory(profileDir);
      if (!await metadata(root, 'default.directory', { privateFile: true, directory: true })) return finish();
      if (role === 'client') {
        const pointerFile = path.join(root, 'client-default.json');
        let exists = true;
        try { await files.lstat(pointerFile); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
        if (exists) {
          const pointerText = await readPublic(pointerFile, 'default.pointer', { privateFile: true, limit: 4096 });
          if (pointerText === undefined) return finish();
          configFile = validateClientDefault(JSON.parse(pointerText));
          add('default.pointer', 'pass', '默认 client 指针通过校验；未读取私钥或启动服务。');
        } else configFile = defaultClientFile(root);
      }
      else {
        const text = await readPublic(path.join(root, 'publisher-default.json'), 'default.pointer', { privateFile: true, limit: 4096 });
        if (text === undefined) return finish();
        const pointer = JSON.parse(text);
        if (!pointer || pointer.schema_version !== 1 || pointer.transport !== 'app-tls' || pointer.role !== 'publisher-default'
            || Object.keys(pointer).some(k => !['schema_version', 'transport', 'role', 'server_config'].includes(k))
            || typeof pointer.server_config !== 'string' || !path.isAbsolute(pointer.server_config)) throw new Error('pointer');
        configFile = sshFile(pointer.server_config);
        add('default.pointer', 'pass', '默认 publisher 指针通过校验；未启动服务。');
      }
    }
  } catch { add('default.pointer', 'fail', '配置路径或默认指针无效。', '显式指定配置，或重新检查 setup-publisher 保存的路径；未修改任何默认项。'); return finish(); }
  const text = await readPublic(configFile, 'config', { privateFile: true, limit: 65536 });
  if (text === undefined) return finish();
  let config;
  try { config = normalizeApplicationConfig(JSON.parse(text), configFile, role); }
  catch { add('config.schema', 'fail', '配置 JSON、schema、角色、路径或端口校验失败。', '仅支持版本化 app-tls；不会降级传输或显示配置内容。'); return finish(); }
  add('config.schema', 'pass', '应用配置通过纯字段校验；未读取 HAI 或私钥内容。');
  await metadata(config.identityFile, 'ssh.identity', { privateFile: true });
  const trust = await metadata(config.knownHostsFile, 'ssh.known_hosts');
  const command = (name, args) => run(name, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, windowsHide: true });
  try {
    const result = await command('ssh', ['-V']);
    if (!/OpenSSH_/.test((result.stdout || '') + (result.stderr || ''))) throw new Error('not_openssh');
    add('ssh.client', 'pass', '本地 OpenSSH 可用；未连接中继，也未执行 SSH 配置。');
  } catch { add('ssh.client', 'fail', '无法确认本地 OpenSSH。', '安装 OpenSSH Client，并在同一终端确认 ssh -V。'); }
  if (trust) {
    let hostname = config.target.split('@')[1];
    if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
    const lookup = config.sshPort === 22 ? hostname : '[' + hostname + ']:' + config.sshPort;
    try {
      const result = await command('ssh-keygen', ['-F', lookup, '-f', config.knownHostsFile]);
      const entries = (result.stdout || '').split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'));
      if (entries.some(line => /^@revoked\s/.test(line.trim()))) add('ssh.trust_record', 'fail', '存在匹配的已撤销主机信任记录。', '通过可信渠道核实；不要为了连接而删除记录。');
      else add('ssh.trust_record', entries.length ? 'pass' : 'fail', entries.length ? '找到已存主机记录；没有核实在线指纹。' : '没有找到匹配主机记录。', entries.length ? undefined : '先通过可信渠道核对指纹；不会自动登记或关闭校验。');
    } catch (error) { add('ssh.trust_record', 'fail', error.code === 1 ? '没有找到匹配主机记录。' : '本地主机信任查找失败。', '检查 ssh-keygen 与 known_hosts；不输出原始诊断。'); }
  }
  if (await metadata(config.tlsDirectory, 'tls.directory', { privateFile: true, directory: true })) {
    const pairText = await readPublic(path.join(config.tlsDirectory, 'pair.json'), 'tls.pair', { privateFile: true, limit: 4096 });
    let pair;
    if (pairText !== undefined) {
      try {
        pair = JSON.parse(pairText);
        const expected = pairingIdentity(config.mode);
        if (!pair || pair.schema_version !== APPLICATION_SCHEMA || pair.experiment !== expected.experiment || pair.server_name !== expected.server_name
            || !['server_pin', 'client_pin'].every(k => typeof pair[k] === 'string' && /^[a-f0-9]{64}$/.test(pair[k]))
            || Object.keys(pair).some(k => !['schema_version', 'experiment', 'server_name', 'server_pin', 'client_pin'].includes(k))) throw new Error('pair');
        add('tls.pair', 'pass', '配对元数据与模式匹配；不会续订或修改配对。');
      } catch { pair = undefined; add('tls.pair', 'fail', '配对元数据无效或与配置模式不匹配。'); }
    }
    const certificates = new Map(), instant = now();
    if (!Number.isFinite(instant)) throw new Error('Invalid diagnostic time');
    for (const name of ['ca', ...(role === 'publisher' ? ['server', 'client'] : ['client'])]) {
      const pem = await readPublic(path.join(config.tlsDirectory, name + '.pem'), 'tls.' + name);
      if (pem === undefined) continue;
      try {
        if (!/^-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/.test(pem.trim())) throw new Error('pem');
        const cert = new X509Certificate(pem); certificates.set(name, cert);
        const from = Date.parse(cert.validFrom), to = Date.parse(cert.validTo);
        if (![from, to].every(Number.isFinite)) throw new Error('time');
        const state = from > instant ? 'not_yet_valid' : to <= instant ? 'expired' : to - instant <= 48 * 3600000 ? 'near_expiry' : 'valid';
        add('tls.' + name + '.validity', ['expired', 'not_yet_valid'].includes(state) ? 'fail' : state === 'near_expiry' ? 'warn' : 'pass',
          { valid: '公开证书当前在有效期内。', near_expiry: '公开证书将在 48 小时内到期。', expired: '公开证书已到期。', not_yet_valid: '公开证书尚未生效。' }[state],
          state === 'valid' ? undefined : '核对系统时间；现有 v1 需要显式创建并导入新配对，未自动续期。',
          { certificate_state: state, valid_from: new Date(from).toISOString(), valid_to: new Date(to).toISOString() });
        if (pair && name !== 'ca') add('tls.' + name + '.pin', cert.fingerprint256.replaceAll(':', '').toLowerCase() === pair[name + '_pin'] ? 'pass' : 'fail', '公开证书与配对固定指纹对照；不输出指纹或证书内容。');
      } catch { add('tls.' + name + '.format', 'fail', '公开证书损坏或不是单一证书；原始内容已隐藏。'); }
    }
    const ca = certificates.get('ca');
    if (ca) add('tls.ca.authority', ca.ca ? 'pass' : 'fail', '检查公开 CA 的签发用途。');
    for (const name of ['server', 'client']) {
      const cert = certificates.get(name);
      if (cert && ca) add('tls.' + name + '.issuer_purpose', !cert.ca && cert.verify(ca.publicKey)
        && cert.keyUsage?.includes('1.3.6.1.5.5.7.3.' + (name === 'server' ? '1' : '2')) ? 'pass' : 'fail', '检查公开证书的 CA 签名与 TLS 用途。');
      if (name === 'server' && cert && pair) add('tls.server.name', cert.checkHost(pair.server_name, { subject: 'never' }) === pair.server_name ? 'pass' : 'fail', '检查公开服务端证书名称。');
    }
    if (role === 'client') notChecked.push('remote_server_certificate_pin_and_name');
    await metadata(path.join(config.tlsDirectory, (role === 'publisher' ? 'server' : 'client') + '.key'), 'tls.private_key', { privateFile: true, limit: 16384 });
    if (config.mode === 'hai') await metadata(path.join(config.tlsDirectory, 'access.json'), 'bridge.access', { privateFile: true, limit: 2048 });
  }
  if (config.authFile) await metadata(config.authFile, 'hai.auth', { privateFile: true });
  for (const [name, port] of role === 'publisher' ? [['app', config.appPort]] : [['http', config.localPort], ['tunnel', config.tunnelPort]]) {
    try { await probe(port); add('port.' + name, 'pass', '本地回环端口曾短暂绑定并释放；不代表链路就绪。', undefined, { loopback_port: port }); }
    catch (error) { add('port.' + name, 'warn', error.code === 'EADDRINUSE' ? '本地端口已占用；可能是正在运行的实例。' : '无法确认本地端口可绑定。', '仅检查本地；不停止任何监听，也不自动换端口。', { loopback_port: port }); }
  }
  return finish();
}

export function formatApplicationInspection(report) {
  return ['应用离线诊断 | ' + report.role + ' | ' + report.status,
    ...report.checks.flatMap(c => ['[' + c.status + '] ' + c.id + ': ' + c.message
      + (c.valid_to ? ' 到期：' + c.valid_to : ''), ...(c.hint ? ['  建议：' + c.hint] : [])]),
    '未检查：' + report.not_checked.join(', ')].join('\n');
}
