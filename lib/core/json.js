// BOM 容忍的 JSON 读取：Windows PowerShell 5.1 的 `Out-File -Encoding utf8`
// 会写 UTF-8 BOM，裸 JSON.parse 会抛错。用户手写的配置文件（config.json /
// 变体描述 / 协议包 descriptor / registry.json）都必须容忍 BOM。

import { readFileSync } from 'node:fs';

export function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readJsonFile(file) {
  try {
    return JSON.parse(stripBom(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}
