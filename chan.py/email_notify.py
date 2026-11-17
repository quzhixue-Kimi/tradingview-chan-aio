#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
通过 Resend（https://resend.com）的 REST API 发送邮件。

前提条件：
    1. 你的域名（如 kq2026.com）已经在 Resend 后台完成域名验证
       （配置了 SPF/DKIM 等 DNS 记录，Resend 控制台里显示 Verified）。
    2. 发件地址（RESEND_FROM）必须是这个已验证域名下的地址，
       例如 bot@kq2026.com、noreply@kq2026.com。
       注意：这里的域名要跟 Resend 里验证的域名一致，
       不一定是 mail.kq2026.com 这个 MX 子域名，取决于你当时在 Resend
       控制台里添加、验证的是哪个域名/子域名，去 Resend 后台 Domains
       页面确认一下实际生效的是哪个。

环境变量：
    RESEND_API_KEY   Resend 的 API Key（在 Resend 后台 API Keys 页面创建，格式 re_xxx）
    RESEND_FROM      发件地址，例如 "缠论分析机器人 <bot@kq2026.com>"
    RESEND_TO        收件地址，例如 admin@kq2026.com（可以是逗号分隔的多个地址）

依赖：
    pip install requests
"""

import os
import requests

RESEND_API_URL = "https://api.resend.com/emails"


def send_email(subject, text, api_key=None, from_addr=None, to_addr=None, timeout=15):
  """
  发送一封邮件

  参数：
      subject: str, 邮件主题
      text: str, 邮件正文（纯文本，内部会包一层 <pre> 保持格式，避免用 HTML 转义麻烦）
      api_key: str, 默认读取环境变量 RESEND_API_KEY
      from_addr: str, 默认读取环境变量 RESEND_FROM
      to_addr: str 或 list[str], 默认读取环境变量 RESEND_TO（逗号分隔会自动拆分）
      timeout: int, 请求超时时间（秒）
  """
  api_key = api_key or os.environ.get("RESEND_API_KEY")
  from_addr = from_addr or os.environ.get("RESEND_FROM")
  to_addr = to_addr or os.environ.get("RESEND_TO")

  if not api_key or not from_addr or not to_addr:
    raise RuntimeError(
      "未配置 Resend 凭证：请设置环境变量 RESEND_API_KEY / RESEND_FROM / RESEND_TO，"
      "或在调用时传入 api_key / from_addr / to_addr 参数"
    )

  if isinstance(to_addr, str):
    to_list = [addr.strip() for addr in to_addr.split(",") if addr.strip()]
  else:
    to_list = list(to_addr)

  # 简单转义，避免正文里的 <、>、& 破坏 HTML 结构；用 <pre> 保留原有的换行和缩进排版
  escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
  html = f"<pre style='font-family: monospace; white-space: pre-wrap;'>{escaped}</pre>"

  payload = {
    "from": from_addr,
    "to": to_list,
    "subject": subject,
    "html": html,
    "text": text,
  }
  headers = {
    "Authorization": f"Bearer {api_key}",
    "Content-Type": "application/json",
  }

  resp = requests.post(RESEND_API_URL, json=payload, headers=headers, timeout=timeout)
  if resp.status_code >= 400:
    raise RuntimeError(f"Resend 发送失败: {resp.status_code} {resp.text}")
  return resp.json()


if __name__ == "__main__":
  # 简单自测：python email_notify.py "测试邮件" "这是一封测试邮件"
  import sys

  subject = sys.argv[1] if len(sys.argv) > 1 else "缠论分析测试邮件"
  body = (
    sys.argv[2]
    if len(sys.argv) > 2
    else "这是一封测试邮件，用于验证 Resend 配置是否正确。"
  )
  result = send_email(subject, body)
  print(f"发送成功: {result}")
