// Human-readable hints only. Structured lifecycle events remain separate.
export function formatApplicationEvent(value) {
  if (value.event === 'application') {
    const prefix = (value.mock ? 'MOCK' : 'HAI') + ' application ' + value.role + ': ';
    if (value.state === 'listening') {
      return prefix + '本地服务已监听 (127.0.0.1:' + value.loopback_port
        + ')；尚未确认中继连接';
    }
    if (value.state === 'stopped') {
      return prefix + '已停止本次本地服务；云端监听是否释放尚未核验';
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
