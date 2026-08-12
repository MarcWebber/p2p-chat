type LandingScreenProps = {
  notice: string;
  onCreateRoom: () => void;
  onClearNotice: () => void;
};

export function LandingScreen({
  notice,
  onCreateRoom,
  onClearNotice,
}: LandingScreenProps) {
  return (
    <main className="landing-shell">
      <header className="landing-header">
        <div className="brand"><span className="brand-mark">2</span><strong>TwoOnly</strong></div>
        <span className="header-note">双人加密聊天</span>
      </header>
      <div className="landing-content">
        <section className="start-card">
          <div className="start-logo">2</div>
          <h1>TwoOnly</h1>
          <p className="start-subtitle">创建一个只允许两个人加入的聊天</p>
          <button className="primary-button" onClick={onCreateRoom}>创建聊天</button>
          <div className="start-features">
            <span>端到端加密</span><i />
            <span>本地保存</span><i />
            <span>图片、语音和视频</span>
          </div>
          <p className="prototype-note">跨设备连接 · 双路加密信令</p>
          {notice ? (
            <div className="landing-notice" role="status">
              <span>{notice}</span>
              <button onClick={onClearNotice} aria-label="关闭提示">×</button>
            </div>
          ) : null}
        </section>

        <section className="wiki-card" aria-labelledby="wiki-title">
          <div className="wiki-heading"><span>使用说明</span><strong id="wiki-title">快速开始 Wiki</strong></div>
          <ol className="wiki-steps">
            <li><b>创建聊天</b><span>点击左侧按钮，生成一条双方通用的双人邀请链接。</span></li>
            <li><b>分享完整链接</b><span>把同一链接发给另一人，链接末尾密钥不能遗漏。</span></li>
            <li><b>等待安全连接</b><span>状态变绿后即可发送文字、图片、语音和视频。</span></li>
          </ol>
          <details open>
            <summary>连接断开怎么办？</summary>
            <p>双方保持页面打开，系统会自动重新握手；仍未恢复时点击“立即重连”。</p>
          </details>
          <details>
            <summary>聊天记录保存在哪里？</summary>
            <p>记录以密文保存在各自浏览器中，不会自动同步到另一台设备。</p>
          </details>
          <details>
            <summary>使用时要注意什么？</summary>
            <p>只通过可信渠道分享完整链接，并与对方核对聊天页顶部的安全码。</p>
          </details>
        </section>
      </div>
      <footer className="landing-footer">消息在浏览器中加密，服务器无法读取聊天内容</footer>
    </main>
  );
}
