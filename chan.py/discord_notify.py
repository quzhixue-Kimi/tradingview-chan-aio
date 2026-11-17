#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
通过 Discord Webhook 发送消息。

Discord 单条消息的 content 最多 2000 个字符，本模块会自动把超长内容
按行切分成多条消息依次发送，避免 400 "Must be 2000 or fewer in length."。

环境变量：
    DISCORD_WEBHOOK_URL   Discord Webhook URL（格式: https://discord.com/api/webhooks/{id}/{token}）

依赖：
    pip install requests
"""

import os
import time

import requests

DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL")

# Discord 限制 content <= 2000
DISCORD_MAX_CONTENT_LENGTH = 2000
# 单段目标长度。比 2000 留出余量：
#   - 避免边界问题
#   - emoji 等字符按 UTF-16 计数时可能占用 2 个长度，留 100 的缓冲
DISCORD_SAFE_CONTENT_LENGTH = 1900
# 连续发送多段时的间隔（秒），避免触发 webhook 频率限制
DISCORD_CHUNK_DELAY = 1.0


def split_message(content, max_length=DISCORD_SAFE_CONTENT_LENGTH):
  """
  把长文本切分成多段，每段不超过 max_length。

  切分优先落在换行处（整行不切断），只有单行本身超长时才硬切。
  同时尽量保持 Markdown 代码块闭合，避免长内容跨消息后渲染错乱。
  """
  text = str(content or "")
  if max_length <= 0:
    raise ValueError("max_length 必须大于 0")
  if not text:
    return []
  if len(text) <= max_length:
    return [text]

  chunks = []
  buf = ""
  fence = None  # 当前未闭合的 Markdown 代码块标记（"```" 或 "~~~"）

  def capacity():
    # 处于代码块内时，需要给结尾的 "\n" + 闭合标记 预留空间
    return max_length - ((len(fence) + 1) if fence else 0)

  def update_fence(line):
    nonlocal fence
    s = line.strip()
    if s.startswith("```") or s.startswith("~~~"):
      fence = None if fence else s[:3]

  def flush():
    nonlocal buf
    if not buf.strip():
      buf = ""
      return
    if fence:
      chunks.append(buf.rstrip("\n") + "\n" + fence)
      buf = fence + "\n"  # 下一段重新打开代码块
    else:
      chunks.append(buf.rstrip("\n"))
      buf = ""

  for line in text.splitlines(keepends=True):
    while line:
      room = capacity() - len(buf)
      if len(line) <= room:
        buf += line
        update_fence(line)
        line = ""
      elif buf and buf.strip() != (fence or "").strip():
        flush()
      else:
        # 单行本身超长（或代码块刚重开就放不下这一行），只能硬切
        room = max(capacity() - len(buf), 1)
        buf += line[:room]
        line = line[room:]
        flush()

  flush()
  return [c for c in chunks if c.strip()]


def _post_chunk(webhook_url, chunk, username, timeout):
  payload = {"content": chunk}
  if username:
    payload["username"] = "Kimi"

  resp = requests.post(webhook_url, json=payload, timeout=timeout)

  # webhook 频率限制：按 Retry-After 等待后重试一次
  if resp.status_code == 429:
    try:
      retry_after = float(resp.headers.get("Retry-After", 1))
    except (TypeError, ValueError):
      retry_after = 1.0
    time.sleep(min(max(retry_after, 0.5), 10.0))
    resp = requests.post(webhook_url, json=payload, timeout=timeout)

  return resp


def send_discord_message(
  content,
  webhook_url=None,
  username=None,
  timeout=15,
  max_length=DISCORD_SAFE_CONTENT_LENGTH,
  chunk_delay=DISCORD_CHUNK_DELAY,
):
  """
  发送一条 Discord 消息；超长内容会自动切分成多段依次发送。

  参数：
      content: str, 消息内容（纯文本）
      webhook_url: str, 默认读取环境变量 DISCORD_WEBHOOK_URL
      username: str, 可选，覆盖 webhook 默认的机器人名字
      timeout: int, 请求超时时间（秒）
      max_length: int, 单段最大长度，默认 1900
      chunk_delay: float, 多段之间的发送间隔（秒）
  """
  webhook_url = webhook_url or DISCORD_WEBHOOK_URL

  if not webhook_url:
    raise RuntimeError("未配置 Discord Webhook URL：请设置环境变量 DISCORD_WEBHOOK_URL")

  chunks = split_message(content, max_length=max_length)
  if not chunks:
    return {
      "status": "ok",
      "status_code": None,
      "chunks": 0,
      "results": [],
    }

  results = []
  total = len(chunks)
  for index, chunk in enumerate(chunks):
    if index > 0 and chunk_delay:
      time.sleep(chunk_delay)

    resp = _post_chunk(webhook_url, chunk, username, timeout)
    if resp.status_code != 204:
      raise RuntimeError(
        f"Discord 发送失败(第 {index + 1}/{total} 段，长度 {len(chunk)}): "
        f"{resp.status_code} {resp.text}"
      )
    results.append({"status_code": resp.status_code, "length": len(chunk)})

  return {
    "status": "ok",
    "status_code": results[-1]["status_code"],
    "chunks": total,
    "results": results,
  }


if __name__ == "__main__":
  import sys

  content = sys.argv[1] if len(sys.argv) > 1 else "这是一条测试消息"
  result = send_discord_message(content)
  print(f"发送成功: {result}")
