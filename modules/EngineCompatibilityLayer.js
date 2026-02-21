// EngineCompatibilityLayer.js
// Ultra Safe Compatibility Adapter
// Does NOT modify original Engine
// Production-grade adapter

class EngineCompatibilityLayer{

constructor(engine){

this.engine=engine

this.renderer=engine.renderer

this.__updateListeners=new Set()

this.__started=false

}

/* =========================
SCENE ACCESS
========================= */

get scene(){

return this.engine.sceneManager?.getScene?.()

}

/* =========================
CAMERA ACCESS
========================= */

get camera(){

return this.engine.cameraSystem?.getCamera?.()

}

/* =========================
INIT
========================= */

init(){

if(this.__started)return

this.__started=true

this.__hookUpdateLoop()

}

/* =========================
UPDATE HOOK
========================= */

__hookUpdateLoop(){

const originalUpdate=this.engine.update.bind(this.engine)

this.engine.update=(delta)=>{

originalUpdate(delta)

const time=this.engine.time||0

for(const fn of this.__updateListeners){

fn(delta,time)

}

}

}

/* =========================
UPDATE EVENTS
========================= */

onUpdate(fn){

this.__updateListeners.add(fn)

}

offUpdate(fn){

this.__updateListeners.delete(fn)

}

/* =========================
PASSTHROUGH FUNCTIONS
========================= */

resize(){

this.engine.resize?.()

}

dispose(){

this.__updateListeners.clear()

}

}

export { EngineCompatibilityLayer }
