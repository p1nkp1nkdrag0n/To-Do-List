import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 原子写入工具会留下隐藏的临时目录，watcher 碰到会 EBUSY 崩掉，直接忽略。
    watch: {
      ignored: [
        "**/.*.tmpdir/**",
        "**/*.tmp",
        // .env 系列不需要热更新；Windows 资源管理器生成的「副本」文件
        // 还会让 watcher 直接 EBUSY 崩掉，一并忽略。
        "**/.env*",
        "**/*副本*",
      ],
    },
    proxy: {
      "/api": "http://localhost:4000",
      "/ws": {
        target: "ws://localhost:4000",
        ws: true,
      },
    },
  },
});
