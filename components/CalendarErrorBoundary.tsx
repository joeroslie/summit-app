'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  onRetry?: () => void;
};

type State = {
  error: Error | null;
};

/**
 * Soft-fail wrapper for Calendar tab — sync / bad payload errors must not
 * take down the rest of Summit.
 */
export class CalendarErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('CalendarErrorBoundary:', error, info.componentStack);
  }

  private retry = () => {
    this.setState({ error: null });
    this.props.onRetry?.();
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="page-shell page-fade space-y-4">
        <h1 className="page-title">Calendar</h1>
        <p className="text-sm text-zinc-600">
          Calendar hit a render error and recovered. Sync again or reconnect
          Google — the rest of Summit stays usable.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" onClick={this.retry}>
            Retry
          </button>
        </div>
      </div>
    );
  }
}
