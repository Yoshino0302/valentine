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
