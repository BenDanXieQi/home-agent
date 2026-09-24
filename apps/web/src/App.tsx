import { BackendStatus } from "./BackendStatus";
import { ServiceConnections } from "./ServiceConnections";
import "./App.css";

function App() {
  return (
    <main className="app-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="Home Agent 首页">
          <span className="brand-mark" aria-hidden="true">
            H
          </span>
          Home Agent
        </a>
        <span className="local-label">本机工作台</span>
      </header>

      <section className="page-intro" aria-labelledby="page-title">
        <p className="eyebrow">服务连接</p>
        <h1 id="page-title">连接你的家庭服务</h1>
        <p>填写已运行的服务地址，查看连接状态。</p>
      </section>

      <ServiceConnections />

      <footer className="app-footer">
        <BackendStatus />
        <span>服务离线不影响后端独立运行</span>
      </footer>
    </main>
  );
}

export default App;
