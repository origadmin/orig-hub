import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from '../../i18n'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  message?: string
}

/**
 * 错误边界：捕获子树渲染期间的未捕获异常，显示可读中文错误而非整树卸载黑屏。
 * 仅包住易失稳的 TG 面板等区域，避免单一组件崩溃拖垮整个应用。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message ?? String(error) }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="text-sm font-medium text-fg-strong">
            {t('error.boundaryTitle', {}, '界面渲染出错')}
          </p>
          <p className="text-xs text-muted">
            {t('error.boundaryDesc', {}, 'TG 面板渲染时发生异常，可重试或检查 TG 服务。')}
          </p>
          {this.state.message && (
            <p className="max-w-md break-all text-[11px] text-danger">{this.state.message}</p>
          )}
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, message: undefined })}
            className="rounded-md bg-accent px-3 py-1.5 text-xs text-white transition-colors hover:bg-accent/90"
          >
            {t('error.retry', {}, '重试')}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}