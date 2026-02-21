// ValentineParticles.js
// Part 1/6
// Ultra Cinematic GPU Particle System
// Production-grade, engine-integrated, GPU optimized

import * as THREE from 'https://jspm.dev/three'

const _tempVec3=new THREE.Vector3()
const _tempColor=new THREE.Color()

class ValentineParticles{

constructor(engine){

this.engine=engine
this.scene=engine.scene

this.group=new THREE.Group()
this.group.name="ValentineParticlesRoot"

this._initialized=false

this._time=0

this._maxParticles=6000

this._geometry=null
this._material=null
this._points=null

this._positions=null
this._velocities=null
this._colors=null
this._sizes=null
this._lifetimes=null
this._ages=null

this._bounds=24

}

init(){

if(this._initialized)return

this._createGeometry()

this._createMaterial()

this._createPoints()

this.scene.add(this.group)

this._initialized=true

}

_createGeometry(){

this._geometry=new THREE.BufferGeometry()

this._positions=new Float32Array(this._maxParticles*3)
this._velocities=new Float32Array(this._maxParticles*3)
this._colors=new Float32Array(this._maxParticles*3)
this._sizes=new Float32Array(this._maxParticles)
this._lifetimes=new Float32Array(this._maxParticles)
this._ages=new Float32Array(this._maxParticles)

for(let i=0;i<this._maxParticles;i++){

this._respawnParticle(i,true)

}

this._geometry.setAttribute(
'position',
new THREE.BufferAttribute(this._positions,3)
)

this._geometry.setAttribute(
'color',
new THREE.BufferAttribute(this._colors,3)
)

this._geometry.setAttribute(
'size',
new THREE.BufferAttribute(this._sizes,1)
)

}
// ValentineParticles.js
// Part 2/6
// Ultra Cinematic Particle Material System

_createMaterial(){

this._material=new THREE.ShaderMaterial({

uniforms:{
uTime:{value:0}
},

vertexShader:`

attribute float size;
attribute vec3 color;

varying vec3 vColor;

uniform float uTime;

void main(){

vColor=color;

vec4 mvPosition=modelViewMatrix*vec4(position,1.0);

gl_PointSize=size*(300.0/-mvPosition.z);

gl_Position=projectionMatrix*mvPosition;

}
`,

fragmentShader:`

varying vec3 vColor;

void main(){

float dist=length(gl_PointCoord-vec2(0.5));

float alpha=smoothstep(0.5,0.0,dist);

vec3 finalColor=vColor;

gl_FragColor=vec4(finalColor,alpha);

}
`,

transparent:true,
depthWrite:false,
blending:THREE.AdditiveBlending,
vertexColors:true

})

}

_createPoints(){

this._points=new THREE.Points(
this._geometry,
this._material
)

this.group.add(this._points)

}
// ValentineParticles.js
// Part 3/6
// Particle Respawn and Valentine Color System

_respawnParticle(index,initial=false){

const i3=index*3

const radius=THREE.MathUtils.randFloat(2,this._bounds)

const theta=Math.random()*Math.PI*2
const phi=Math.random()*Math.PI

const x=radius*Math.sin(phi)*Math.cos(theta)
const y=THREE.MathUtils.randFloat(-this._bounds*0.5,this._bounds*0.5)
const z=radius*Math.sin(phi)*Math.sin(theta)

this._positions[i3+0]=x
this._positions[i3+1]=y
this._positions[i3+2]=z

const speed=THREE.MathUtils.randFloat(0.1,0.6)

this._velocities[i3+0]=THREE.MathUtils.randFloatSpread(speed)
this._velocities[i3+1]=THREE.MathUtils.randFloat(0.05,0.35)
this._velocities[i3+2]=THREE.MathUtils.randFloatSpread(speed)

const colorChoice=Math.random()

if(colorChoice<0.25){

_tempColor.setRGB(1.0,0.2,0.5)

}else if(colorChoice<0.5){

_tempColor.setRGB(1.0,0.05,0.2)

}else if(colorChoice<0.75){

_tempColor.setRGB(0.7,0.2,1.0)

}else{

_tempColor.setRGB(0.3,0.8,1.0)

}

this._colors[i3+0]=_tempColor.r
this._colors[i3+1]=_tempColor.g
this._colors[i3+2]=_tempColor.b

this._sizes[index]=THREE.MathUtils.randFloat(6,22)

this._lifetimes[index]=THREE.MathUtils.randFloat(4,12)

this._ages[index]=initial?Math.random()*this._lifetimes[index]:0

}
// ValentineParticles.js
// Part 4/6
// Ultra Cinematic Particle Animation Update System

update(delta){

if(!this._initialized)return

this._time+=delta

this._material.uniforms.uTime.value=this._time

const posAttr=this._geometry.attributes.position
const colorAttr=this._geometry.attributes.color
const sizeAttr=this._geometry.attributes.size

for(let i=0;i<this._maxParticles;i++){

const i3=i*3

this._ages[i]+=delta

if(this._ages[i]>=this._lifetimes[i]){

this._respawnParticle(i,false)

continue

}

this._positions[i3+0]+=this._velocities[i3+0]*delta
this._positions[i3+1]+=this._velocities[i3+1]*delta
this._positions[i3+2]+=this._velocities[i3+2]*delta

this._velocities[i3+1]+=Math.sin(
this._time*0.8+i
)*0.0005

const lifeRatio=this._ages[i]/this._lifetimes[i]

const fade=Math.sin(lifeRatio*Math.PI)

sizeAttr.array[i]=this._sizes[i]*fade

}
this._updateAdvancedMotion(delta)
posAttr.needsUpdate=true
colorAttr.needsUpdate=true
sizeAttr.needsUpdate=true

}
// ValentineParticles.js
// Part 5/6
// Advanced Cinematic Orbital and Swirl Motion System

_applyOrbitalMotion(index,delta){

const i3=index*3

const x=this._positions[i3+0]
const z=this._positions[i3+2]

const angle=Math.atan2(z,x)

const radius=Math.sqrt(x*x+z*z)

const orbitalSpeed=0.15

const newAngle=angle+orbitalSpeed*delta

this._positions[i3+0]=Math.cos(newAngle)*radius
this._positions[i3+2]=Math.sin(newAngle)*radius

}

_applyAttractionToCore(index,delta){

const i3=index*3

_tempVec3.set(
-this._positions[i3+0],
-this._positions[i3+1],
-this._positions[i3+2]
)

const dist=_tempVec3.length()

if(dist>0.001){

_tempVec3.normalize()

const strength=0.08

this._velocities[i3+0]+=_tempVec3.x*strength*delta
this._velocities[i3+1]+=_tempVec3.y*strength*delta
this._velocities[i3+2]+=_tempVec3.z*strength*delta

}

}

_applySwirlMotion(index,delta){

const i3=index*3

const swirl=Math.sin(
this._time*0.6+index*0.1
)*0.2

this._velocities[i3+0]+=Math.cos(swirl)*0.002
this._velocities[i3+2]+=Math.sin(swirl)*0.002

}

// Inject advanced motion into main update loop

_updateAdvancedMotion(delta){

for(let i=0;i<this._maxParticles;i++){

this._applyOrbitalMotion(i,delta)

this._applyAttractionToCore(i,delta)

this._applySwirlMotion(i,delta)

}

}
// ValentineParticles.js
// Part 6/6
// Final Cleanup, Dispose, and Export

dispose(){

if(!this._initialized)return

this.scene.remove(this.group)

if(this._points){

this._points.geometry?.dispose()

}

this._geometry?.dispose()

this._material?.dispose()

this._positions=null
this._velocities=null
this._colors=null
this._sizes=null
this._lifetimes=null
this._ages=null

this._points=null
this._geometry=null
this._material=null

this._initialized=false

}

}

export { ValentineParticles }
