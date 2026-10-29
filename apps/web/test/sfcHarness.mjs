import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as Vue from 'vue'

const require = createRequire(import.meta.url)
// 编译磁盘上的当前SFC；不复制组件业务函数，也不添加生产测试导出。
export async function compileCurrentSfc(filename, mocks, { ssr = false, globals = {} } = {}) {
  const source = await readFile(new URL(`../src/${filename}`,import.meta.url),'utf8')
  const { descriptor, errors } = parse(source,{filename})
  if (errors.length) throw errors[0]
  const script = compileScript(descriptor,{id:filename,genDefaultAs:'__component'})
  function evaluate(code) {
    const module = {exports:{}}
    const context = vm.createContext({module,exports:module.exports,console,URLSearchParams,...globals,require(name) {
      if (Object.hasOwn(mocks,name)) return mocks[name]
      if (name.startsWith('.')) throw new Error(`SFC测试缺少隔离模块：${name}`)
      return require(name)
    }})
    const output = ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}})
    vm.runInContext(output.outputText,context,{filename})
    return module.exports
  }
  const component = evaluate(script.content+'\nexport default __component').default
  if (ssr) {
    const template = compileTemplate({source:descriptor.template.content,filename,id:filename,ssr:true,ssrCssVars:[],compilerOptions:{bindingMetadata:script.bindings}})
    if (template.errors.length) throw template.errors[0]
    component.ssrRender = evaluate(template.code).ssrRender
  } else component.render = () => null
  return component
}

export function mountScript(component) {
  const node = text=>({text,children:[],parent:null})
  const renderer = Vue.createRenderer({
    createElement:node,createText:node,createComment:node,
    insert(child,parent) {child.parent=parent;parent.children.push(child)},
    remove(child) {if(child.parent) child.parent.children=child.parent.children.filter(n=>n!==child)},
    setText(n,text){n.text=text},setElementText(n,text){n.text=text},patchProp(){},
    parentNode:n=>n.parent,nextSibling:()=>null,querySelector:()=>null,
    setScopeId(){},insertStaticContent(){throw new Error('脚本隔离renderer不渲染模板')}
  })
  const root=node('root'),vnode=Vue.h(component)
  renderer.render(vnode,root)
  return {state:vnode.component.setupState,unmount:()=>renderer.render(null,root)}
}

export async function flushSfc() {
  await Vue.nextTick()
  await new Promise(resolve=>setImmediate(resolve))
  await Vue.nextTick()
}
