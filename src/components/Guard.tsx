// When a screen runs into a problem while drawing, it shows what happened and
// a way back instead of going blank. The details go to the app's log.
import { Component, type ReactNode } from "react";
import { api } from "../api";

type Props = { children: ReactNode; onHome: () => void };
type State = { error: Error | null };

export class ScreenGuard extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    void api.logPageError(`${error.message}\n${error.stack ?? ""}\n${info.componentStack ?? ""}`).catch(() => {});
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="screen">
        <section className="card" role="alert" style={{ maxWidth: 560, margin: "40px auto", display: "grid", gap: 12 }}>
          <p className="eyebrow">Something went wrong</p>
          <h2 style={{ margin: 0, fontWeight: 400, letterSpacing: "-0.03em" }}>This screen ran into a problem</h2>
          <p className="meta" style={{ margin: 0 }}>
            Your photos and library are fine. The details were written to the app's log (Settings › Help can export it).
          </p>
          <code className="mono" style={{ fontSize: 12, color: "var(--muted)", overflowWrap: "anywhere" }}>{error.message}</code>
          <div className="row-flex" style={{ gap: 8 }}>
            <button type="button" className="btn primary" onClick={() => this.setState({ error: null })}>Try again</button>
            <button type="button" className="btn quiet" onClick={() => { this.setState({ error: null }); this.props.onHome(); }}>Go to Dashboard</button>
          </div>
        </section>
      </div>
    );
  }
}
