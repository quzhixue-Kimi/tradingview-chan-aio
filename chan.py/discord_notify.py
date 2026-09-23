#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
通过 Discord Webhook 发送消息。

环境变量：
    DISCORD_WEBHOOK_URL   Discord Webhook URL（格式: https://discord.com/api/webhooks/{id}/{token}）

依赖：
    pip install requests
"""

import os
import requests

DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL")


def send_discord_message(content, webhook_url=None, username=None, timeout=15):
  """
  发送一条 Discord 消息

  参数：
      content: str, 消息内容（纯文本）
      webhook_url: str, 默认读取环境变量 DISCORD_WEBHOOK_URL
      username: str, 可选，覆盖 webhook 默认的机器人名字
      timeout: int, 请求超时时间（秒）
  """
  webhook_url = webhook_url or DISCORD_WEBHOOK_URL

  if not webhook_url:
    raise RuntimeError("未配置 Discord Webhook URL：请设置环境变量 DISCORD_WEBHOOK_URL")

  payload = {"content": content}
  if username:
    payload["username"] = "Kimi"

  resp = requests.post(webhook_url, json=payload, timeout=timeout)
  if resp.status_code != 204:
    raise RuntimeError(f"Discord 发送失败: {resp.status_code} {resp.text}")
  return {"status": "ok", "status_code": resp.status_code}


if __name__ == "__main__":
  import sys

  content = sys.argv[1] if len(sys.argv) > 1 else "这是一条测试消息"
  result = send_discord_message(content)
  print(f"发送成功: {result}")
