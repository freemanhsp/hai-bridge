// Human-readable hints only. Structured lifecycle events remain separate.
export function formatApplicationEvent(value) {
  if (value.event === 'device_tls') {
    const hints = { server_certificate_renewed: 'A 服务器证书已续订；B 不需要重新配对',
      root_rotation_required_soon: 'A 根信任将在30天内到期；需要手动安排新的信任配对',
      renewal_unavailable: 'A 证书续订暂不可用；有效旧证书保留，失效时拒绝服务' };
    return '设备 TLS: ' + (hints[value.state] || value.state);
  }
  if (value.event === 'device_auth') return '设备认证: 设备记录不可读/损坏；已拒绝请求并取消活动连接，未自动修复';
  if (value.event === 'application') {
    const prefix = (value.mock ? 'MOCK' : 'HAI') + ' application ' + value.role + ': ';
    if (value.state === 'listening') {
      return prefix + '本地服务已监听 (127.0.0.1:' + value.loopback_port
        + ')；尚未确认中继连接';
    }
    if (value.state === 'stopped') {
      return prefix + '已停止本次本地服务；云端监听是否释放尚未核验';
    }
    if (value.state === 'cleanup_failed') {
      return prefix + '清理未完整确认 (' + value.reason + ')；本地服务：' + value.local_service
        + '，自有 SSH：' + value.owned_ssh + '；云端释放未核验，不会结束未知进程';
    }
    return prefix + value.state + (value.reason ? ' (' + value.reason + ')' : '');
  }
  const prefix = 'SSH ' + value.direction + ': ';
  if (value.state === 'starting') {
    return prefix + '正在连接中继 (starting，尚未确认成功)\n'
      + '前台常驻：请保持终端打开；Ctrl-C 停止。'
      + (value.direction === 'publish'
        ? '若没有后续确认，用 B 端 doctor 或 ECS 监听检查。'
        : '完整链路请用 doctor 验证。');
  }
  if (value.state === 'forward_ready') {
    return prefix + '中继监听已建立 (forward_ready，ECS 127.0.0.1:' + value.loopback_port
      + '，OpenSSH 确认)\n可启动 B 端；B→HAI 完整链路仍需 doctor 验证。';
  }
  if (value.state === 'retry_wait') {
    return prefix + '连接中断，' + value.delay_ms / 1000 + ' 秒后重试 (' + value.retry
      + '/' + value.max_retries + ')；不会重放模型请求';
  }
  return prefix + value.state + (value.reason ? ' (' + value.reason + ')' : '')
    + (value.hint ? '; ' + value.hint : '');
}
