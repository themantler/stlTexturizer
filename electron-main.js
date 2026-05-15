const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

app.commandLine.appendSwitch('max-old-space-size', '32768')
app.commandLine.appendSwitch('js-flags', '--expose-gc --max-old-space-size=32768')

let mainWindow
let server

app.whenReady().then(() => {
  server = spawn('npx', ['serve', '.'], {
    cwd: path.join(__dirname),
    shell: true
  })

  // Create window immediately but keep retrying until server is ready
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: ['--max-old-space-size=32768']
    },
    title: 'STLTexturizer'
  })
  mainWindow.on('closed', () => { mainWindow = null })

  // Retry every 500ms for up to 20 attempts (10 seconds total)
  tryLoad(mainWindow, 20)
})

function tryLoad(win, attempts) {
  const http = require('http')
  http.get('http://localhost:3000', (res) => {
    if (res.statusCode === 200) {
      win.loadURL('http://localhost:3000')
    } else {
      if (attempts > 0) setTimeout(() => tryLoad(win, attempts - 1), 500)
    }
  }).on('error', () => {
    if (attempts > 0) setTimeout(() => tryLoad(win, attempts - 1), 500)
  })
}

function createWindow() {
  // No longer needed — window created directly in whenReady
}

// Handle save dialog from renderer
ipcMain.handle('show-save-dialog', async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options)
  return result
})

// Handle file write from renderer
ipcMain.handle('write-file', async (event, filePath, buffer) => {
  fs.writeFileSync(filePath, Buffer.from(buffer))
  return true
})

app.whenReady().then(() => {
  server = spawn('npx', ['serve', '.'], {
    cwd: path.join(__dirname),
    shell: true
  })
})

app.on('window-all-closed', () => {
  if (server) server.kill()
  if (process.platform !== 'darwin') app.quit()
})