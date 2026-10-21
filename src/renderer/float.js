/** 悬浮小球：录音时贴在屏幕角落显示时长，点一下回到主窗口。 */
const dot = document.getElementById('dot')
const time = document.getElementById('time')
const meta = document.getElementById('meta')

window.localVoice.onStatus((status) => {
  const seconds = Math.floor((status.elapsedMs ?? 0) / 1000)
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
  const ss = String(seconds % 60).padStart(2, '0')
  time.textContent = `${mm}:${ss}`
  dot.classList.toggle('paused', status.phase !== 'recording')
  meta.textContent = status.chars > 0 ? `${status.chars} 字` : ''
})

document.body.addEventListener('click', () => window.localVoice.showMain())
