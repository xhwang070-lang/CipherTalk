import { useEffect, useState } from 'react'
import './SplashPage.css'

function SplashPage() {
  const [fadeOut, setFadeOut] = useState(false)

  useEffect(() => {
    document.body.classList.add('splash-transparent')

    const readyTimer = setTimeout(() => {
      try {
        window.electronAPI?.window?.splashReady?.()
      } catch (e) {
        console.error('通知启动屏就绪失败:', e)
      }
    }, 400)

    const cleanup = window.electronAPI?.window?.onSplashFadeOut?.(() => setFadeOut(true))

    return () => {
      clearTimeout(readyTimer)
      cleanup?.()
      document.body.classList.remove('splash-transparent')
    }
  }, [])

  return (
    <div className={'splash-page' + (fadeOut ? ' splash-page--out' : '')}>
      <div className="splash-card">
        <div className="splash-name">华记</div>
        <div className="splash-text">正在加载</div>
      </div>
    </div>
  )
}

export default SplashPage
