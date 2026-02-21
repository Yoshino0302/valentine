// ValentineScene.js
// Part 1/6
// Ultra Cinematic Valentine Scene Controller
// Production-grade integration with Engine

import * as THREE from 'https://jspm.dev/three'
import { ValentineObjects } from './ValentineObjects.js'
import { ValentineParticles } from './ValentineParticles.js'

class ValentineScene{

constructor(engine){

this.engine=engine

this.scene=engine.scene
this.camera=engine.camera
this.renderer=engine.renderer

this.group=new THREE.Group()
this.group.name="ValentineSceneRoot"

this.objects=null
this.particles=null

this._initialized=false

this._time=0

this._lightingGroup=new THREE.Group()

this._postGroup=new THREE.Group()

}

init(){

if(this._initialized)return

this._setupSceneEnvironment()

this._createLighting()

this._createObjects()

this._createParticles()

this.scene.add(this.group)

this._initialized=true

}
// ValentineScene.js
// Part 2/6
// Ultra Cinematic Environment and Renderer Setup

_setupSceneEnvironment(){

this.scene.background=new THREE.Color(0x050010)

this.scene.fog=new THREE.FogExp2(
0x140018,
0.035
)

this.renderer.toneMapping=THREE.ACESFilmicToneMapping

this.renderer.toneMappingExposure=1.4

this.renderer.outputColorSpace=THREE.SRGBColorSpace

this.renderer.physicallyCorrectLights=true

this.renderer.shadowMap.enabled=true

this.renderer.shadowMap.type=THREE.PCFSoftShadowMap

this.camera.position.set(0,2,10)

this.camera.lookAt(0,0,0)

}
// ValentineScene.js
// Part 3/6
// Ultra Cinematic Valentine Lighting System

_createLighting(){

this.scene.add(this._lightingGroup)

const ambient=new THREE.AmbientLight(
0xff66cc,
0.35
)

this._lightingGroup.add(ambient)

const mainLight=new THREE.PointLight(
0xff2a6d,
14,
60,
2
)

mainLight.position.set(0,3,4)

this._lightingGroup.add(mainLight)

const fillLight=new THREE.PointLight(
0xaa44ff,
10,
50,
2
)

fillLight.position.set(-6,2,-4)

this._lightingGroup.add(fillLight)

const rimLight=new THREE.PointLight(
0x44ccff,
8,
40,
2
)

rimLight.position.set(6,4,-6)

this._lightingGroup.add(rimLight)

const topLight=new THREE.PointLight(
0xffffff,
6,
50,
2
)

topLight.position.set(0,8,0)

this._lightingGroup.add(topLight)

this._animateLights(mainLight,fillLight,rimLight,topLight)

}

_animateLights(mainLight,fillLight,rimLight,topLight){

this.engine.onUpdate((delta,time)=>{

const t=time*0.5

mainLight.position.x=Math.sin(t)*4
mainLight.position.z=Math.cos(t)*4

fillLight.position.x=Math.cos(t*0.7)*6
fillLight.position.z=Math.sin(t*0.7)*6

rimLight.position.y=4+Math.sin(t)*2

topLight.intensity=6+Math.sin(t*2)*2

})

}
// ValentineScene.js
// Part 4/6
// Load and Integrate Valentine Systems

_createObjects(){

this.objects=new ValentineObjects(this.engine)

this.objects.init()

this.group.add(this.objects.group)

}

_createParticles(){

this.particles=new ValentineParticles(this.engine)

this.particles.init()

this.group.add(this.particles.group)

}
// ValentineScene.js
// Part 5/6
// Scene Update and Cinematic Camera Motion

update(delta,time){

if(!this._initialized)return

this._time=time

this._animateCamera(delta,time)

this.objects?.update(delta,time)

this.particles?.update(delta,time)

}

_animateCamera(delta,time){

const radius=10

const speed=0.12

const angle=time*speed

this.camera.position.x=Math.cos(angle)*radius
this.camera.position.z=Math.sin(angle)*radius

this.camera.position.y=3+Math.sin(time*0.8)*1.2

this.camera.lookAt(0,0,0)

}
// ValentineScene.js
// Part 6/6
// Final Lifecycle Integration, Cleanup, Export

start(){

if(!this._initialized)return

this._updateHandler=(delta,time)=>{

this.update(delta,time)

}

this.engine.onUpdate(this._updateHandler)

}

stop(){

if(this._updateHandler){

this.engine.offUpdate(this._updateHandler)

this._updateHandler=null

}

}

dispose(){

this.stop()

this.scene.remove(this.group)

this.objects?.dispose()
this.particles?.dispose()

this.objects=null
this.particles=null

this._initialized=false

}

}

export { ValentineScene }
