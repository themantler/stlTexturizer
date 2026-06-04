const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const http = require('http')
const fs = require('fs')
const path = require('path')

app.commandLine.appendSwitch('max-old-space-size', '32768')
app.commandLine.appendSwitch('js-flags', '--expose-gc --max-old-space-size=32768')

let mainWindow
let server

const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.ico':  'image/x-icon',
  '.ttf':  'font/ttf',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
}

function startServer(rootDir, port) {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let urlPath = req.url.split('?')[0]
      if (urlPath === '/') urlPath = '/index.html'
      const filePath = path.join(rootDir, urlPath)
      const ext = path.extname(filePath).toLowerCase()
      const mime = MIME_TYPES[ext] || 'application/octet-stream'
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404)
          res.end('Not found')
        } else {
          res.writeHead(200, { 'Content-Type': mime })
          res.end(data)
        }
      })
    })
    server.listen(port, '127.0.0.1', () => resolve())
  })
}

app.whenReady().then(async () => {
  await startServer(__dirname, 3000)

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
  mainWindow.loadURL('http://localhost:3000')
})

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

app.on('window-all-closed', () => {
  if (server) server.close()
  if (process.platform !== 'darwin') app.quit()
})