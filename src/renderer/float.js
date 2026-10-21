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

// 点击（握把以外）回到主窗口
document.body.addEventListener('click', (event) => {
  if (event.target.closest('.grip')) return
  window.localVoice.showMain()
})

// 双击也回主窗口，手感更接近系统小组件
document.body.addEventListener('dblclick', () => window.localVoice.showMain())
