import { useEffect, useState } from "react";

import { Modal } from "../../components/Modal";
import { api } from "../../lib/api";

const SEEN_KEY = "todolist.first-run-guide.v1";

/**
 * 首次打开时的「使用须知」。
 * 这些坑几乎每个新用户都会踩一次：两个名字的区别、纪要人名、手机连不上、Key 配错。
 * 只在本机第一次打开时出现，点「我知道了」后不再打扰。
 */
export function FirstRunGuide() {
  // 记住“读过”只对同一套安装有效；数据库被清空（回到首次运行）时要重新提示，
  // 否则重装后新用户看不到这份说明。
  const [seen, setSeen] = useState(() => {
    try {
      return window.localStorage.getItem(SEEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [dismissed, setDismissed] = useState(false);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ needsBootstrap: boolean }>("/api/auth/bootstrap-status")
      .then((result) => {
        if (!cancelled && result.needsBootstrap) setNeedsBootstrap(true);
      })
      .catch(() => {
        // 读不到状态就按“已安装”处理，不额外打扰。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const open = !dismissed && (!seen || needsBootstrap);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const dismiss = () => {
    try {
      window.localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // 隐私模式写不进去也没关系，下次还会提示。
    }
    setDismissed(true);
    setSeen(true);
  };

  if (!open) return null;

  return (
    <Modal title="开始之前，请先看这 5 条" width="medium" onClose={dismiss}>
      <div className="modal-body first-run-guide">
        <ol>
          <li>
            <b>两个名字别搞混</b>
            <p>
              <code>用户名</code> 用来登录（只能用字母、数字、下划线，3–32 位）；
              <code>显示名称</code> 是团队里显示的名字，<b>可以写中文</b>。
            </p>
          </li>
          <li>
            <b>会议纪要里的人名，要写「显示名称」</b>
            <p>
              而且必须是<b>本项目的成员</b>。格式：
              <code>甲负责订营地，2 个小时</code>（「甲」换成成员的显示名称）。
              名字对不上，这条任务会被丢掉。
            </p>
          </li>
          <li>
            <b>手机/别的电脑要连，必须在同一个 WiFi</b>
            <p>
              关掉 Windows 防火墙访问限制后，用窗口里显示的
              <code>http://192.168.x.x:4000</code> 访问。
              <b>校园网、公司网常常禁止设备互访</b>，最稳的是开手机热点。
            </p>
          </li>
          <li>
            <b>不配大模型 Key 也能用</b>
            <p>
              规则解析只认「谁 + 做什么 + 几小时」。想要更聪明的抽取（尤其是文档式纪要），
              到<b>手动 → AI 设置</b>填 Key，填完点<b>测试</b>确认能用。
            </p>
          </li>
          <li>
            <b>数据就在本机，记得备份</b>
            <p>
              数据库是 <code>ToDoList-data\data\app.sqlite</code>（或
              <code>%LOCALAPPDATA%\ToDoList\data</code>）。
              拷走这个文件就等于备份了全部账号、项目和任务。
            </p>
          </li>
        </ol>
        <footer className="first-run-actions">
          <button className="primary-button" type="button" onClick={dismiss}>
            我知道了
          </button>
        </footer>
      </div>
    </Modal>
  );
}
