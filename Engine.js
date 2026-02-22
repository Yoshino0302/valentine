import * as THREE from 'https://jspm.dev/three'

class Engine{

constructor(){

this.canvas=document.createElement('canvas')

document.body.appendChild(this.canvas)

this.renderer=new THREE.WebGLRenderer({
canvas:this.canvas,
antialias:true,
alpha:false,
powerPreference:"high-performance"
})

this.renderer.setPixelRatio(Math.min(window.devicePixelRatio,2))

this.renderer.setSize(window.innerWidth,window.innerHeight)

this.renderer.outputColorSpace=THREE.SRGBColorSpace

this.scene=new THREE.Scene()

this.camera=new THREE.PerspectiveCamera(
60,
window.innerWidth/window.innerHeight,
0.1,
1000
)

this.camera.position.set(0,2,10)

this.clock=new THREE.Clock()

this._updateHandlers=new Set()

this._running=false

window.addEventListener("resize",this._onResize.bind(this))

}

_onResize(){

this.camera.aspect=window.innerWidth/window.innerHeight

this.camera.updateProjectionMatrix()

this.renderer.setSize(window.innerWidth,window.innerHeight)

}

onUpdate(fn){

this._updateHandlers.add(fn)

}

offUpdate(fn){

this._updateHandlers.delete(fn)

}

_startLoop(){

if(this._running)return

this._running=true

const loop=()=>{

const delta=this.clock.getDelta()

const elapsed=this.clock.elapsedTime

for(const fn of this._updateHandlers){

fn(delta,elapsed)

}

this.renderer.render(this.scene,this.camera)

requestAnimationFrame(loop)

}

loop()

}

start(){

this._startLoop()

}

}

export default Engine
