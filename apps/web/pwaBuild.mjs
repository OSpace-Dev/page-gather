import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, relative, sep } from 'node:path'

// 只枚举实际构建产物，无运行时依赖，不按用户导航扩展缓存。
export function publicShell() {
  let output = ''
  const emitted = new Set()
  return {
    name:'page-gather-public-shell',
    apply:'build',
    configResolved(config) { output = resolve(config.root,config.build.outDir) },
    generateBundle(_options,bundle) { emitted.clear(); for (const path of Object.keys(bundle)) if (/^assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(path)) emitted.add('/'+path) },
    async closeBundle() {
      async function files(dir) {
        const entries = await readdir(dir,{withFileTypes:true})
        const paths = await Promise.all(entries.map(e => e.isDirectory() ? files(resolve(dir,e.name)) : [resolve(dir,e.name)]))
        return paths.flat()
      }
      const allowed = (await files(output)).map(file=>({file,path:'/'+relative(output,file).split(sep).join('/')})).filter(({path})=>['/index.html','/offline.html','/manifest.webmanifest','/icons/icon-192.png','/icons/icon-512.png'].includes(path) || emitted.has(path)).sort((a,b)=>a.path.localeCompare(b.path))
      for (const path of ['/index.html','/offline.html','/manifest.webmanifest','/icons/icon-192.png','/icons/icon-512.png']) if (!allowed.some(asset=>asset.path===path)) throw new Error('PWA 公开 shell 产物缺失')
      const hash = createHash('sha256')
      for(const {file,path} of allowed) { hash.update(path); hash.update(await readFile(file)) }
      const source = await readFile(resolve(output,'sw.js'),'utf8')
      if(!source.includes('__PWA_VERSION__') || !source.includes("/* __PWA_PRECACHE__ */ ['/offline.html']")) throw new Error('PWA 构建模板缺失')
      hash.update(source)
      const version = hash.digest('hex').slice(0,20)
      await writeFile(resolve(output,'sw.js'),source.replace('__PWA_VERSION__',version).replace("/* __PWA_PRECACHE__ */ ['/offline.html']",JSON.stringify(allowed.map(x=>x.path))))
    }
  }
}
