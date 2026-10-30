import { useState } from "react";
import {
  AudioLines,
  BookOpen,
  CalendarClock,
  KeyRound,
  ListChecks,
  Mic,
  Network,
  ShieldCheck,
  UserRound,
  Wifi,
} from "lucide-react";

import { Modal } from "../../components/Modal";

type SectionId =
  | "start"
  | "names"
  | "minutes"
  | "key"
  | "voice"
  | "live"
  | "availability"
  | "network"
  | "data"
  | "faq";

const SECTIONS: Array<{
  id: SectionId;
  title: string;
  icon: typeof BookOpen;
}> = [
  { id: "start", title: "五分钟上手", icon: ListChecks },
  { id: "names", title: "用户名与显示名称", icon: UserRound },
  { id: "minutes", title: "会议纪要怎么写", icon: BookOpen },
  { id: "key", title: "配置大模型 Key", icon: KeyRound },
  { id: "voice", title: "录音转写（思必驰）", icon: Mic },
  { id: "live", title: "实时会议（边说边出任务）", icon: AudioLines },
  { id: "availability", title: "可用时间与容量", icon: CalendarClock },
  { id: "network", title: "手机与局域网访问", icon: Wifi },
  { id: "data", title: "数据、备份与卸载", icon: ShieldCheck },
  { id: "faq", title: "常见问题", icon: Network },
];

/** 首次使用会踩的坑都写在这里；从侧栏「使用说明」随时打开。 */
export function HelpDialog({ onClose }: { onClose: () => void }) {
  const [active, setActive] = useState<SectionId>("start");

  return (
    <Modal title="使用说明" width="large" onClose={onClose}>
      <div className="help-layout">
        <nav className="help-nav" aria-label="说明目录">
          {SECTIONS.map((section) => {
            const Icon = section.icon;
            return (
              <button
                key={section.id}
                type="button"
                className={active === section.id ? "active" : ""}
                onClick={() => setActive(section.id)}
              >
                <Icon size={15} />
                <span>{section.title}</span>
              </button>
            );
          })}
        </nav>

        <div className="help-body">
          {active === "start" ? (
            <section>
              <h3>五分钟上手</h3>
              <ol className="help-steps">
                <li>
                  <b>创建管理员</b>
                  <p>第一次打开会要求创建账号：显示名称写你希望在团队里显示的名字，用户名只用于登录。</p>
                </li>
                <li>
                  <b>建项目并邀请成员</b>
                  <p>
                    一个比赛或一个课题建一个项目。成员可以是自己注册后被你拉进来的人，
                    <b>纪要里的人名必须和他们的显示名称一致</b>。
                  </p>
                </li>
                <li>
                  <b>设置可用时间</b>
                  <p>
                    左侧「可用时间」→ 添加学期 → 涂每周空闲时段 → 填每周投入上限。
                    不设置的话容量是 0 小时，排期会认为谁都排不进任务。
                  </p>
                </li>
                <li>
                  <b>粘贴会议纪要</b>
                  <p>会议页 → 粘贴纪要 → 开始处理。系统会抽任务、建排期、发现冲突并给出修复方案。</p>
                </li>
                <li>
                  <b>看甘特图与冲突</b>
                  <p>处理完会自动跳到甘特图；红色标记表示超期、容量不足、缺可用时间或依赖倒挂。</p>
                </li>
              </ol>
            </section>
          ) : null}

          {active === "names" ? (
            <section>
              <h3>用户名与显示名称</h3>
              <table className="help-table">
                <thead>
                  <tr><th>字段</th><th>例子</th><th>用途</th><th>规则</th></tr>
                </thead>
                <tbody>
                  <tr><td>用户名</td><td>chai.zixiao</td><td><b>登录</b>用</td><td>字母/数字/下划线/点/短横线，3–32 位</td></tr>
                  <tr><td>显示名称</td><td>柴子笑</td><td><b>团队显示 + 纪要匹配</b></td><td>可用中文，1–80 字</td></tr>
                </tbody>
              </table>
              <p className="help-note">
                注册时如果用户名里写了中文，会提示“只能用字母、数字、下划线…”。
                想用中文名字，请写在<b>显示名称</b>里。
              </p>
              <h4>纪要匹配规则</h4>
              <ul>
                <li>只认<b>显示名称</b>，不认用户名。</li>
                <li>必须<b>完全一致</b>（多空格、加“老师”都算不同）。</li>
                <li>必须是<b>当前项目的成员</b>；注册了但没加进项目不算。</li>
                <li>匹配不上的人，那条任务会被丢弃。</li>
              </ul>
            </section>
          ) : null}

          {active === "minutes" ? (
            <section>
              <h3>会议纪要怎么写</h3>
              <p>推荐写成「谁 + 负责什么 + 几小时 + 什么时候前」：</p>
              <pre className="help-code">{`甲负责订营地，2 个小时，这周五之前。
乙负责买装备，4 个小时。
丙负责写路线和攻略，3 个小时。
丁负责拍照和剪视频，5 个小时，下周一之前。`}</pre>
              <h4>三种写法都能识别</h4>
              <ul>
                <li><code>甲：订营地，2 个小时</code></li>
                <li><code>甲负责订营地，2 个小时</code></li>
                <li><code>订营地由甲负责，2 个小时</code></li>
              </ul>
              <h4>没有配置 Key 时的限制</h4>
              <p>
                规则解析只认上面这种「谁 + 几小时」的句子。文档式纪要（大段描述、没有明确分工）
                需要配置大模型 Key 才能抽取。
              </p>
              <h4>为什么一条都没抽出来</h4>
              <ul>
                <li>纪要里的人名和成员显示名称对不上。</li>
                <li>没有写工时（规则模式下工时是必要条件）。</li>
                <li>这个人不在当前项目里。</li>
              </ul>
            </section>
          ) : null}

          {active === "key" ? (
            <section>
              <h3>配置大模型 Key</h3>
              <ol className="help-steps">
                <li>
                  <b>打开设置</b>
                  <p>会议页右上角「手动」→「AI 设置」。</p>
                </li>
                <li>
                  <b>选平台并填 Key</b>
                  <p>
                    内置 DeepSeek、硅基流动、通义、智谱、Kimi 等预设，也可以填自定义地址。
                    填完点该行的<b>测试</b>，能返回模型列表才算通。
                  </p>
                </li>
                <li>
                  <b>选择模型</b>
                  <p>测试通过后选择模型；不确定就用平台默认的对话模型。</p>
                </li>
              </ol>
              <h4>常见报错</h4>
              <table className="help-table">
                <thead><tr><th>提示</th><th>含义</th><th>处理</th></tr></thead>
                <tbody>
                  <tr><td>401 / 403 · 密钥无效</td><td>Key 打错、过期，或不属于这个平台</td><td>重新复制粘贴；确认平台地址与 Key 同源</td></tr>
                  <tr><td>404 · 用不了该模型</td><td>模型名不对，或国内/国际站混用</td><td>换预设模型；Kimi 注意 .cn 与 .ai</td></tr>
                  <tr><td>429 · 太频繁或额度不足</td><td>限流或余额不够</td><td>等一会儿，或充值</td></tr>
                  <tr><td>连接超时</td><td>网络到不了该平台</td><td>检查代理/校园网，换网络再试</td></tr>
                </tbody>
              </table>
              <p className="help-note">
                Key 只保存在本机数据库里，每台安装各自独立；换电脑或重装后需要重新填一次。
              </p>
            </section>
          ) : null}

          {active === "voice" ? (
            <section>
              <h3>录音转写（思必驰）</h3>
              <p>
                会议页的「上传会议录音」会把音频送到思必驰的「录音文件长语音转写」服务，
                自动转成文字并按说话人分段（发言人1、发言人2…），再走后面的抽任务流程。
              </p>
              <h4>需要准备的凭证</h4>
              <ol className="help-steps">
                <li><b>创建产品</b><p>DUI 控制台 → 基础技术 → 创建产品，勾选「录音文件长语音转写」。</p></li>
                <li><b>领额度</b><p>购买 24 小时体验包（约 10 元）或正式套餐；没有额度会报「额度不足」。</p></li>
                <li><b>申请 APIKEY</b><p>授权管理 → 接入 API → 申请 APIKEY，IP 白名单可填 <code>0.0.0.0/0</code>。</p></li>
                <li><b>填进应用</b><p>会议页「手动 → AI 设置」底部「语音转写（思必驰）」填 productId + apiKey。</p></li>
              </ol>
              <h4>不想每人注册思必驰？</h4>
              <p>
                配好的人可以在「AI 设置 → 语音转写 → 自己填写」里点「复制分享配置」，
                把一串 <code>asr://...</code> 发给队友；队友在「导入团队配置」里粘贴即可，
                不用注册、不用实名、不用买套餐。
              </p>
              <p className="help-note">
                这串里包含明文 Key。建议在控制台单独建一把「队友临时」Key，
                IP 白名单填比赛场地，赛后删掉；不要用长期在用的那把。
              </p>
              <h4>支持的音频</h4>
              <p>mp3 / wav / m4a / aac / ogg，单个文件 5 小时以内、500MB 以内；转写按时长扣额度。</p>
              <h4>常见报错</h4>
              <table className="help-table">
                <thead><tr><th>提示</th><th>原因</th></tr></thead>
                <tbody>
                  <tr><td>额度不足</td><td>产品没有套餐，或免费/体验额度已用完</td></tr>
                  <tr><td>鉴权失败（120000）</td><td>productId/apiKey 不对，或当前公网 IP 不在白名单</td></tr>
                  <tr><td>不支持的音频格式</td><td>用 mp3/wav/m4a 再试；浏览器录音的 webm 暂不支持</td></tr>
                  <tr><td>转写结果为空</td><td>音频里没有可识别的人声</td></tr>
                </tbody>
              </table>
              <p className="help-note">
                IP 白名单绑定调用方公网 IP：换网络（比如去比赛场地）后，要回控制台把新 IP 加进去，
                或者直接填 0.0.0.0/0 不做限制。
              </p>
            </section>
          ) : null}

          {active === "live" ? (
            <section>
              <h3>实时会议（边说边出任务）</h3>
              <p>
                会议页点「实时记录」，对着麦克风说话，1–2 秒后字幕出现在左边；
                右边的「AI 任务草稿」会随着你说的话逐条冒出来。说完点「结束并生成排期」，
                会自动纠正人名、抽任务、建排期，直接进甘特图。
              </p>

              <h4>用之前要准备什么</h4>
              <ol className="help-steps">
                <li>
                  <b>思必驰实时长语音转写</b>
                  <p>
                    这是和「录音文件转写」分开的服务：DUI 控制台创建产品时勾选
                    「实时长语音转写」，并购买时长套餐（没有额度会返回 120100）。
                  </p>
                </li>
                <li>
                  <b>填 productId + apiKey</b>
                  <p>会议页「手动 → AI 设置 → 语音转写」填好，点「测试连接」确认鉴权通过。</p>
                </li>
                <li>
                  <b>用 Chrome 打开</b>
                  <p>
                    浏览器麦克风只在 <code>127.0.0.1</code> 或 HTTPS 下可用；
                    局域网 IP（如 192.168.x.x）会被浏览器禁用。
                  </p>
                </li>
              </ol>

              <h4>怎么用</h4>
              <ol className="help-steps">
                <li><b>选麦克风</b><p>右上角下拉框选「麦克风阵列」或系统默认；选错设备会出现「没有声音」。</p></li>
                <li><b>开始说话</b><p>正常音量，一次说完整句子；左边的字会一直累积，可以往上翻。</p></li>
                <li><b>看草稿</b><p>右边的任务草稿按标题去重，不会覆盖之前的结果。</p></li>
                <li><b>结束并生成排期</b><p>自动纠错人名（如把「叶恒」改成「邱业恒」）并进入现有的排期流程。</p></li>
              </ol>

              <h4>常见问题</h4>
              <table className="help-table">
                <thead><tr><th>现象</th><th>原因 / 处理</th></tr></thead>
                <tbody>
                  <tr><td>麦克风条有声音，但没有字幕</td><td>先换 Chrome；Edge 会把部分阵列麦克风处理成低频噪声</td></tr>
                  <tr><td>麦克风条一直是「没有声音」</td><td>系统输入设备选错，或麦克风被静音；到 Windows 声音设置里换设备</td></tr>
                  <tr><td>字幕一直不出来</td><td>实时服务没开通/没额度；到控制台看服务授权和剩余时长</td></tr>
                  <tr><td>任务草稿是空的</td><td>说的内容里没有「谁 + 做什么 + 多久」；补上负责人和工时</td></tr>
                  <tr><td>点结束没有反应</td><td>一句话都没识别出来时按钮不可用；先说几句再结束</td></tr>
                </tbody>
              </table>

              <h4>和「上传录音」怎么选</h4>
              <p>
                实时会议适合现场演示和短会；已经有录音文件时用「上传会议录音」更稳。
                实时接口出问题时，随时可以退回上传录音，后续抽任务和排期完全一样。
              </p>
              <p className="help-note">
                实时字幕约 1–2 秒延迟，不是毫秒级；长会议建议每 10–15 分钟点一次「结束并生成排期」。
              </p>
            </section>
          ) : null}

          {active === "availability" ? (
            <section>
              <h3>可用时间与容量</h3>
              <h4>为什么显示 0 小时</h4>
              <p>
                还没建「学期模板」。没有模板时容量按 0 计算，任何任务都会被判定排不进去。
              </p>
              <h4>怎么填</h4>
              <ol className="help-steps">
                <li><b>添加学期</b><p>设置生效日期范围（默认本学期）和每周投入上限（例如 10 小时）。</p></li>
                <li><b>涂每周时段</b><p>以 30 分钟为单位点选你有空的时间，可以按住拖动连续涂。</p></li>
                <li><b>临时例外</b><p>某天加班、请假，用「临时可用 / 不可用」单独设置，不影响每周模板。</p></li>
              </ol>
              <h4>别人能看到什么</h4>
              <p>团队成员只能看到忙闲区间、容量和冲突结果，看不到你的私人备注。</p>
              <h4>容量怎么用</h4>
              <p>排期时按成员的每周上限和可用时段分配工时；超出就会标红并给出拆分或延期方案。</p>
            </section>
          ) : null}

          {active === "network" ? (
            <section>
              <h3>手机与局域网访问</h3>
              <h4>谁需要装程序</h4>
              <p>只有主机需要装。其他人用浏览器访问主机地址即可，注册时需要管理员发的邀请码。</p>
              <h4>访问地址</h4>
              <p>启动窗口会打印两个地址：</p>
              <ul>
                <li><code>http://127.0.0.1:4000</code> → 主机自己用</li>
                <li><code>http://192.168.x.x:4000</code> → 同一 WiFi 下的手机/电脑用</li>
              </ul>
              <h4>打不开的常见原因</h4>
              <table className="help-table">
                <thead><tr><th>现象</th><th>原因</th><th>处理</th></tr></thead>
                <tbody>
                  <tr><td>手机显示“无法访问”</td><td>不在同一 WiFi</td><td>连同一个 WiFi；校园网/公司网常禁止设备互访，最稳是开手机热点</td></tr>
                  <tr><td>主机自己都打不开</td><td>服务没启动或端口被占</td><td>看窗口是否显示“已启动”；换个端口重试</td></tr>
                  <tr><td>第一次弹出管理员确认</td><td>加防火墙规则</td><td>点“是”；点“否”只影响别人访问</td></tr>
                </tbody>
              </table>
              <p className="help-note">
                主机休眠、合盖、切换 WiFi 都会让其他人断开；演示时把电源设为“从不休眠”。
              </p>
            </section>
          ) : null}

          {active === "data" ? (
            <section>
              <h3>数据、备份与卸载</h3>
              <h4>数据在哪</h4>
              <p>启动窗口会打印「数据目录」，数据库文件名是 <code>app.sqlite</code>：</p>
              <ul>
                <li>正常电脑：<code>%LOCALAPPDATA%\ToDoList\data\app.sqlite</code></li>
                <li>受限电脑（写不了 AppData）：程序目录下的 <code>ToDoList-data\data\app.sqlite</code></li>
              </ul>
              <h4>怎么备份</h4>
              <p>先关闭程序窗口，再复制 <code>app.sqlite</code> 到 U 盘或网盘。恢复时放回同一位置即可。</p>
              <h4>删除与重装</h4>
              <ul>
                <li>删除 exe：数据仍然保留。</li>
                <li>删除数据目录：账号、项目、Key 全部清空，回到首次运行。</li>
                <li>覆盖新版本 exe：程序更新，数据保留。</li>
              </ul>
              <p className="help-note">
                示例任务和演示账号不会出现在你的安装里；你看到的所有内容都是自己创建的。
              </p>
            </section>
          ) : null}

          {active === "faq" ? (
            <section>
              <h3>常见问题</h3>
              <dl className="help-faq">
                <dt>注册时提示“payload is invalid”</dt>
                <dd>用户名写了中文或太短。用户名只能字母、数字、下划线、点、短横线，3–32 位；中文写在显示名称里。</dd>

                <dt>提示“没能从这段纪要里抽出任务”</dt>
                <dd>三种原因：人名不是成员显示名称、没写工时、或纪要太“文档化”。先对照本说明的「会议纪要怎么写」。</dd>

                <dt>提示“大模型密钥无效或已过期”</dt>
                <dd>Key 打错或不属于该平台。到 AI 设置重新填，点「测试」；换电脑后需要重填一次。</dd>

                <dt>可用时间是 0 小时</dt>
                <dd>还没建学期模板。到「可用时间」→「添加学期」→ 填每周上限并涂时段。</dd>

                <dt>引导弹窗挡住页面 / 卡在某一步</dt>
                <dd>新版会自动切到对应页面再定位；实在找不到会自动跳过。也可以点「跳过本段」。</dd>

                <dt>手机打不开地址</dt>
                <dd>确认同一 WiFi；校园网常隔离设备，改用手机热点。窗口里显示的地址以 192.168 或 10/172 开头才对。</dd>

                <dt>关闭窗口后数据没了？</dt>
                <dd>不会。数据在数据目录里，重新双击 exe 就还在。</dd>

                <dt>能不能多人同时用</dt>
                <dd>可以，同一台主机上多人登录不同账号协作，其他人的浏览器不需要装程序。</dd>
              </dl>
            </section>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
