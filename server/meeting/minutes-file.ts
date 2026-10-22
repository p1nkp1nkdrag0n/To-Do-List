/**
 * 会议纪要文件解析：把上传的 txt / docx / pdf 变成纯文本。
 *
 * 只做一件事——把文字拿出来。抽取质量仍然交给 extractor（DeepSeek / 规则）。
 */
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

export const SUPPORTED_MINUTES_EXTENSIONS = [".txt", ".md", ".markdown", ".docx", ".pdf"];

export interface ParsedMinutes {
  filename: string;
  extension: string;
  chars: number;
  text: string;
}

function extensionOf(filename: string): string {
  const index = filename.lastIndexOf(".");
  return index < 0 ? "" : filename.slice(index).toLowerCase();
}

export async function parseMinutesFile(
  filename: string,
  buffer: Buffer,
): Promise<ParsedMinutes> {
  const extension = extensionOf(filename);
  let text: string;

  if ([".txt", ".md", ".markdown", ".csv"].includes(extension)) {
    text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  } else if (extension === ".docx") {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value;
  } else if (extension === ".pdf") {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      text = result.text;
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  } else if (extension === ".doc") {
    throw new Error("旧版 .doc 不支持，请在 Word 里另存为 .docx 再上传。");
  } else {
    throw new Error(
      `不支持的文件类型 ${extension || "(无扩展名)"}，可用：${SUPPORTED_MINUTES_EXTENSIONS.join(" / ")}`,
    );
  }

  // PDF 抽出来的行会带很多空行，顺手压缩一下，别让模型读到一堆空白。
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (normalized.length < 10) {
    throw new Error("文件里没读到有效文字（可能是扫描件或加密 PDF）。");
  }

  return { filename, extension, chars: normalized.length, text: normalized };
}
