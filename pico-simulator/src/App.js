import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Tube, RoundedBox, Text, Instance, Instances, Html } from '@react-three/drei';
import * as THREE from 'three';

// --- 1. Python実行エンジン ---
function usePythonEngine() {
  const [pinStates, setPinStates] = useState({});
  const [ready, setReady] = useState(false);
  const [logs, setLogs] = useState([]);
  const pyodideRef = useRef(null);
  const isRunningRef = useRef(false);

  useEffect(() => {
    const init = async () => {
      if (window.loadPyodide && !pyodideRef.current) {
        try {
          const py = await window.loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.23.4/full/" });
          pyodideRef.current = py;
          window.picoPinUpdate = (pin, state) => { if (isRunningRef.current) setPinStates(prev => ({ ...prev, [pin]: state })); };
          window.picoLog = (msg) => { if (isRunningRef.current) setLogs(prev => [...prev, "> " + msg]); };
          py.setStdout({ batched: (msg) => { if (isRunningRef.current) setLogs(prev => [...prev, msg]) }});
          setReady(true);
        } catch (e) { console.error(e); }
      }
    };
    init();
  }, []);

  const run = async (inputCode) => {
    if (!pyodideRef.current) return;
    isRunningRef.current = true;
    setPinStates({});
    setLogs([">>> 実行開始"]);
    let transformedCode = inputCode.replace(/time\.sleep\(/g, "await asyncio.sleep(");
    const header = "import asyncio\nimport time\n"; 
    const shim = `
import js
class Pin:
    OUT = "OUT"
    IN = "IN"
    def __init__(self, pin, mode=OUT): 
        self.pin = pin
        self.mode = mode
    def value(self, val):
        js.window.picoPinUpdate(self.pin, val == 1)
def print(*args):
    msg = " ".join(map(str, args))
    js.window.picoLog(msg)
`;
    try {
      await pyodideRef.current.runPythonAsync(shim + "\n" + header + transformedCode);
      if (isRunningRef.current) setLogs(prev => [...prev, ">>> 実行終了"]);
    } catch (err) {
      if (isRunningRef.current) setLogs(prev => [...prev, "Error: " + err.message]);
    }
  };

  const stop = () => {
    isRunningRef.current = false;
    setPinStates({});
    setLogs(prev => [...prev, ">>> 停止 (リセット)"]);
  };

  return { pinStates, ready, logs, run, stop };
}

// --- 2. 座標 & 物理定数 ---
const PITCH = 0.254;
const ROW_COUNT = 30;

function getHolePos(row, col) {
  const zOffset = -((ROW_COUNT - 1) * PITCH) / 2;
  const z = zOffset + (row - 1) * PITCH;
  let x = 0;
  if (col <= 5) x = -((GAP_CENTER / 2) + (5 - col) * PITCH);
  else x = (GAP_CENTER / 2) + (col - 6) * PITCH;
  return [x, 0.15, z];
}
const GAP_CENTER = 0.762;

function getHoleId(row, col) {
  const side = col <= 5 ? 'L' : 'R';
  return `${side}-${row}`;
}

function getGpioFromHole(row, col) {
  if (col <= 5) {
    const leftMap = { 1:0, 2:1, 4:2, 5:3, 6:4, 7:5, 9:6, 10:7, 11:8, 12:9, 14:10, 15:11, 16:12, 17:13, 19:14, 20:15 };
    return leftMap[row] !== undefined ? leftMap[row] : null;
  } else {
    const rightMap = { 20:16, 19:17, 17:18, 16:19, 15:20, 14:21, 12:22, 10:26, 9:27, 7:28 };
    return rightMap[row] !== undefined ? rightMap[row] : null;
  }
}

// --- 3. 3D部品 ---
function Tooltip({ position, text }) {
  return (
    <Html position={position} style={{ pointerEvents: 'none' }}>
      <div style={{ background: 'rgba(0,0,0,0.8)', color: 'white', padding: '4px 8px', borderRadius: '4px', fontSize: '12px', whiteSpace: 'nowrap', transform: 'translate3d(-50%, -150%, 0)' }}>
        {text}
      </div>
    </Html>
  );
}

function Electron({ path, speed = 0.5, offset = 0 }) {
  const meshRef = useRef();
  const progress = useRef(offset);
  useFrame((state, delta) => {
    if (!meshRef.current || !path) return;
    progress.current += speed * delta;
    if (progress.current > 1) progress.current -= 1;
    meshRef.current.position.copy(path.getPointAt(progress.current));
  });
  return <mesh ref={meshRef}><sphereGeometry args={[0.025]} /><meshBasicMaterial color="#ffff00" toneMapped={false}/></mesh>;
}

function useComponentPath(start, end, height) {
  return useMemo(() => {
    const pStart = new THREE.Vector3(...start);
    const pEnd = new THREE.Vector3(...end);
    const sink = 0.3;
    const realStart = pStart.clone().setY(pStart.y - sink);
    const realEnd = pEnd.clone().setY(pEnd.y - sink);
    const upStart = pStart.clone().setY(height);
    const upEnd = pEnd.clone().setY(height);
    const points = [realStart, pStart, upStart, upEnd, pEnd, realEnd];
    return new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.05);
  }, [start, end, height]);
}

function ResistorComponent({ item, hasCurrent, setHoverInfo }) {
  const { sR, sC, eR, eC, scale, ohms = 330 } = item;
  const start = getHolePos(sR, sC);
  const end = getHolePos(eR, eC);
  const height = 0.4 * scale;
  const path = useComponentPath(start, end, height);
  const mid = new THREE.Vector3(...start).add(new THREE.Vector3(...end)).multiplyScalar(0.5).setY(height);
  const direction = new THREE.Vector3(...end).sub(new THREE.Vector3(...start));
  const angleY = Math.atan2(direction.x, direction.z) + Math.PI / 2;
  const legRadius = 0.015 * scale;

  return (
    <group 
      onPointerOver={(e) => { e.stopPropagation(); setHoverInfo({ pos: mid, text: `${ohms}Ω` }); }}
      onPointerOut={() => setHoverInfo(null)}
    >
      <group position={mid} rotation={[0, angleY, 0]} scale={[scale, scale, scale]}>
        <mesh rotation={[0,0,Math.PI/2]}><cylinderGeometry args={[0.12, 0.12, 0.6]} /><meshStandardMaterial color="#e0c0a0" /></mesh>
        <mesh rotation={[0,0,Math.PI/2]} position={[0.15, 0, 0]}><cylinderGeometry args={[0.125, 0.125, 0.05]} /><meshStandardMaterial color="brown" /></mesh>
        <mesh rotation={[0,0,Math.PI/2]} position={[0.05, 0, 0]}><cylinderGeometry args={[0.125, 0.125, 0.05]} /><meshStandardMaterial color="black" /></mesh>
        <mesh rotation={[0,0,Math.PI/2]} position={[-0.05, 0, 0]}><cylinderGeometry args={[0.125, 0.125, 0.05]} /><meshStandardMaterial color="red" /></mesh>
        <mesh rotation={[0,0,Math.PI/2]} position={[-0.2, 0, 0]}><cylinderGeometry args={[0.125, 0.125, 0.05]} /><meshStandardMaterial color="gold" metalness={0.8} /></mesh>
      </group>
      <Tube args={[path, 64, legRadius, 8, false]}><meshStandardMaterial color="silver" metalness={0.8} roughness={0.2} /></Tube>
      {hasCurrent && [0, 0.2, 0.4, 0.6, 0.8].map(i => <Electron key={i} path={path} offset={i} speed={0.5} />)}
    </group>
  );
}

function LEDComponent({ item, hasCurrent, setHoverInfo }) {
  const { sR, sC, eR, eC } = item;
  const start = getHolePos(sR, sC);
  const end = getHolePos(eR, eC);
  const height = 0.5;
  const path = useComponentPath(start, end, height);
  const mid = new THREE.Vector3(...start).add(new THREE.Vector3(...end)).multiplyScalar(0.5).setY(height + 0.1); 

  return (
    <group
      onPointerOver={(e) => { e.stopPropagation(); setHoverInfo({ pos: mid, text: `LED` }); }}
      onPointerOut={() => setHoverInfo(null)}
    >
      <group position={mid}>
        <mesh position={[0, 0.2, 0]}><sphereGeometry args={[0.18, 32, 16, 0, Math.PI * 2, 0, Math.PI/2]} /><meshStandardMaterial color={hasCurrent ? "#ff0000" : "#aa0000"} emissive={hasCurrent ? "#ff0000" : "#000"} emissiveIntensity={hasCurrent ? 2 : 0} transparent opacity={0.9} roughness={0.1}/></mesh>
        <mesh position={[0, 0.05, 0]}><cylinderGeometry args={[0.18, 0.18, 0.3]} /><meshStandardMaterial color={hasCurrent ? "#ff0000" : "#aa0000"} emissive={hasCurrent ? "#ff0000" : "#000"} transparent opacity={0.9} /></mesh>
        <mesh position={[0, -0.1, 0]}><cylinderGeometry args={[0.2, 0.2, 0.05]} /><meshStandardMaterial color={hasCurrent ? "#ff0000" : "#aa0000"} transparent opacity={0.8} /></mesh>
      </group>
      <Tube args={[path, 64, 0.015, 8, false]}><meshStandardMaterial color="silver" metalness={0.8} roughness={0.2} /></Tube>
      {hasCurrent && [0, 0.2, 0.4, 0.6, 0.8].map(i => <Electron key={i} path={path} offset={i} />)}
    </group>
  );
}

function CleanWire({ item, hasCurrent, setHoverInfo }) {
  const { sR, sC, eR, eC, color } = item;
  const start = getHolePos(sR, sC);
  const end = getHolePos(eR, eC);
  const path = useMemo(() => {
    const pStart = new THREE.Vector3(...start); pStart.y += 0.15;
    const pEnd = new THREE.Vector3(...end); pEnd.y += 0.15;
    const lift = 0.5 + (2 * 0.2); 
    const points = [pStart, new THREE.Vector3(pStart.x, lift, pStart.z), new THREE.Vector3(pEnd.x, lift, pEnd.z), pEnd];
    return new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.1);
  }, [start, end]);

  const mid = path.getPointAt(0.5);

  return (
    <group 
      onPointerOver={(e) => { e.stopPropagation(); setHoverInfo({ pos: mid, text: `Wire` }); }}
      onPointerOut={() => setHoverInfo(null)}
    >
      <Tube args={[path, 64, 0.045, 8, false]}><meshPhysicalMaterial color={color} transparent opacity={0.4} roughness={0.2} metalness={0.1} /></Tube>
      <mesh position={[start[0],0.1,start[2]]}><cylinderGeometry args={[0.025,0.025,0.4]}/><meshStandardMaterial color="#ccc"/></mesh>
      <mesh position={[end[0],0.1,end[2]]}><cylinderGeometry args={[0.025,0.025,0.4]}/><meshStandardMaterial color="#ccc"/></mesh>
      {hasCurrent && [0,0.2,0.4,0.6,0.8].map(i => <Electron key={i} path={path} offset={i} />)}
    </group>
  );
}

function Breadboard({ onHoleClick, selectedHole }) {
  const holes = useMemo(() => {
    const temp = [];
    for (let r=1; r<=ROW_COUNT; r++) {
      for (let c=1; c<=10; c++) temp.push({pos: getHolePos(r,c), r, c});
    }
    return temp;
  }, []);
  return (
    <group position={[0, -0.15, 0]}>
      <RoundedBox args={[5.5, 0.3, ROW_COUNT*PITCH+0.5]} radius={0.1}><meshStandardMaterial color="#fff"/></RoundedBox>
      <Instances range={holes.length}>
        <boxGeometry args={[0.12, 0.1, 0.12]} />
        <meshStandardMaterial color="#111" />
        {holes.map((h, i) => (<Instance key={i} position={[h.pos[0], 0.15, h.pos[2]]} onClick={(e) => { e.stopPropagation(); onHoleClick(h.r, h.c); }} />))}
      </Instances>
      {selectedHole && <mesh position={[getHolePos(selectedHole.row, selectedHole.col)[0], 0.16, getHolePos(selectedHole.row, selectedHole.col)[2]]} rotation={[-Math.PI/2, 0, 0]}><ringGeometry args={[0.08, 0.12, 32]} /><meshBasicMaterial color="yellow" side={THREE.DoubleSide} /></mesh>}
    </group>
  );
}

function Pico({ pinStates }) {
  const [, yRef, zRef] = getHolePos(1, 3);
  const isInternalLedOn = pinStates[25];
  const leftPins = [{name:"GP0",color:"#fff"},{name:"GP1",color:"#fff"},{name:"GND",color:"#000",bg:"#ccc"},{name:"GP2",color:"#fff"},{name:"GP3",color:"#fff"},{name:"GP4",color:"#fff"},{name:"GP5",color:"#fff"},{name:"GND",color:"#000",bg:"#ccc"},{name:"GP6",color:"#fff"},{name:"GP7",color:"#fff"},{name:"GP8",color:"#fff"},{name:"GP9",color:"#fff"},{name:"GND",color:"#000",bg:"#ccc"},{name:"GP10",color:"#fff"},{name:"GP11",color:"#fff"},{name:"GP12",color:"#fff"},{name:"GP13",color:"#fff"},{name:"GND",color:"#000",bg:"#ccc"},{name:"GP14",color:"#fff"},{name:"GP15",color:"#fff"}];
  const rightPins = [{name:"VBUS",color:"#ffcccc"},{name:"VSYS",color:"#ffcccc"},{name:"GND",color:"#000",bg:"#ccc"},{name:"3V3_EN",color:"#ffcccc"},{name:"3V3",color:"#ffcccc"},{name:"ADC_REF",color:"#ffcccc"},{name:"GP28",color:"#fff"},{name:"GND",color:"#000",bg:"#ccc"},{name:"GP27",color:"#fff"},{name:"GP26",color:"#fff"},{name:"RUN",color:"#ffcccc"},{name:"GP22",color:"#fff"},{name:"GND",color:"#000",bg:"#ccc"},{name:"GP21",color:"#fff"},{name:"GP20",color:"#fff"},{name:"GP19",color:"#fff"},{name:"GP18",color:"#fff"},{name:"GND",color:"#000",bg:"#ccc"},{name:"GP17",color:"#fff"},{name:"GP16",color:"#fff"}];
  return (
    <group position={[0, yRef+0.05, zRef+(19*PITCH)/2]}>
      <RoundedBox args={[2.1, 0.08, 5.2]} radius={0.05}><meshStandardMaterial color="#006600"/></RoundedBox>
      <mesh position={[0, 0.15, -2.4]}><boxGeometry args={[0.8, 0.25, 0.6]} /><meshStandardMaterial color="silver" /></mesh>
      <Text position={[0, 0.1, 0]} rotation={[-Math.PI/2, 0, 0]} fontSize={0.4}>RPi Pico</Text>
      <mesh position={[-0.4, 0.1, -1.8]}><boxGeometry args={[0.2, 0.05, 0.2]} /><meshStandardMaterial color={isInternalLedOn ? "#00ff00" : "#003300"} emissive={isInternalLedOn ? "#00ff00" : "#000"} /></mesh>
      <Text position={[-0.4, 0.11, -1.5]} rotation={[-Math.PI/2, 0, 0]} fontSize={0.15} color="white">LED</Text>
      {Array.from({ length: 20 }).map((_, i) => (
        <React.Fragment key={i}>
          <group position={[-0.889, -0.15, -2.413 + i * PITCH]}><mesh position={[0, 0.08, 0]}><boxGeometry args={[0.1, 0.1, 0.24]} /><meshStandardMaterial color="black" /></mesh><mesh position={[0, 0, 0]}><cylinderGeometry args={[0.03, 0.03, 0.5]} /><meshStandardMaterial color="gold" metalness={1} roughness={0.3} /></mesh><Text position={[-0.5, 0.21, 0]} rotation={[-Math.PI/2, 0, 0]} fontSize={0.12} color={leftPins[i].color} anchorX="right" outlineWidth={0.01} outlineColor="#003300">{leftPins[i].name}</Text></group>
          <group position={[0.889, -0.15, -2.413 + i * PITCH]}><mesh position={[0, 0.08, 0]}><boxGeometry args={[0.1, 0.1, 0.24]} /><meshStandardMaterial color="black" /></mesh><mesh position={[0, 0, 0]}><cylinderGeometry args={[0.03, 0.03, 0.5]} /><meshStandardMaterial color="gold" metalness={1} roughness={0.3} /></mesh><Text position={[0.5, 0.21, 0]} rotation={[-Math.PI/2, 0, 0]} fontSize={0.12} color={rightPins[i].color} anchorX="left" outlineWidth={0.01} outlineColor="#003300">{rightPins[i].name}</Text></group>
        </React.Fragment>
      ))}
    </group>
  );
}


// --- 4. メインアプリUI ---

export default function App() {
  const { pinStates, ready, logs, run, stop } = usePythonEngine();
  const [leftPanelWidth, setLeftPanelWidth] = useState(500);
  const [editorHeight, setEditorHeight] = useState(400);
  const [hoverInfo, setHoverInfo] = useState(null);

  // 初期データ
  const [wires, setWires] = useState([
    { sR: 20, sC: 2, eR: 25, eC: 2, color: "green", id: 1, level: 2 },
    { id: 2, sR: 25, sC: 10, eR: 3, eC: 10, color: "black", level: 1 }
  ]);
  const [leds, setLeds] = useState([
    { sR: 25, sC: 7, eR: 25, eC: 8, id: 1 }
  ]);
  const [resistors, setResistors] = useState([
    { sR: 25, sC: 3, eR: 25, eC: 6, scale: 1, ohms: 330, id: 1 }
  ]);
  const [code, setCode] = useState(`import time\ntest = Pin(15, Pin.OUT)\n\nprint("Start")\nfor i in range(5):\n    test.value(1)\n    time.sleep(0.5)\n    test.value(0)\n    time.sleep(0.5)\nprint("Done")`);

  const [selectedHole, setSelectedHole] = useState(null);
  const [editingId, setEditingId] = useState(null); 
  const [editType, setEditType] = useState(null); 

  const [inputWire, setInputWire] = useState({ sR: 1, sC: 1, eR: 1, eC: 1, color: 'blue' });
  const [inputLed, setInputLed] = useState({ sR: 1, sC: 1, eR: 2, eC: 1 });
  const [inputResistor, setInputResistor] = useState({ sR: 1, sC: 1, eR: 2, eC: 1, scale: 1.0, ohms: 330 });

  // --- ★ 物理演算 (経路探索・接続ロジック) ---
  const activeComponents = useMemo(() => {
    // 1. 接続グラフの構築 (Union-Find的なグループ化)
    const adj = {};
    const addLink = (id1, id2) => {
      if(!adj[id1]) adj[id1] = [];
      if(!adj[id2]) adj[id2] = [];
      adj[id1].push(id2);
      adj[id2].push(id1);
    };

    // 全ての部品の接続を登録
    [...wires, ...leds, ...resistors].forEach(item => {
      const start = getHoleId(item.sR, item.sC);
      const end = getHoleId(item.eR, item.eC);
      addLink(start, end);
    });

    // 2. ソース(電源)とシンク(GND)を探す
    const sources = [];
    const sinks = [];
    
    // 全ての穴について、GPIO接続かGND接続かをチェック
    // 接続が存在する穴だけループ
    Object.keys(adj).forEach(holeId => {
      const [side, rowStr] = holeId.split('-');
      const row = parseInt(rowStr);
      const col = side === 'L' ? 1 : 6;
      const pin = getGpioFromHole(row, col);
      
      // GPIOがHIGHならソース
      if (pin !== null && pinStates[pin]) {
        sources.push(holeId);
      }
      
      // GNDピン (Row 3, 8, 13, 18, 23, 28) ならシンク
      // 左列も右列も同じRow配置と仮定 (Pico仕様)
      if ([3, 8, 13, 18, 23, 28, 33, 38].includes(row)) {
        sinks.push(holeId);
      }
    });

    // 3. 到達可能チェック (BFS)
    // ソースから電気が届く場所
    const powered = new Set();
    const queueP = [...sources];
    queueP.forEach(s => powered.add(s));
    while(queueP.length > 0) {
      const curr = queueP.shift();
      if(adj[curr]) {
        adj[curr].forEach(next => {
          if(!powered.has(next)) {
            powered.add(next);
            queueP.push(next);
          }
        });
      }
    }

    // シンクへ電気が戻れる場所 (逆方向BFS)
    const grounded = new Set();
    const queueG = [...sinks];
    queueG.forEach(s => grounded.add(s));
    while(queueG.length > 0) {
      const curr = queueG.shift();
      if(adj[curr]) {
        adj[curr].forEach(next => {
          if(!grounded.has(next)) {
            grounded.add(next);
            queueG.push(next);
          }
        });
      }
    }

    // 4. 両方を満たす部品IDを特定
    const activeIds = new Set();
    
    // ワイヤー、LED、抵抗それぞれについてチェック
    const checkActive = (item) => {
      const start = getHoleId(item.sR, item.sC);
      const end = getHoleId(item.eR, item.eC);
      // 片方がPoweredで片方がGroundedならOK、またはその逆、または両方が両属性持ち(ループ内など)
      // シンプルに「両端がPoweredかつGroundedな経路上にある」と判定
      if ((powered.has(start) && grounded.has(end)) || (powered.has(end) && grounded.has(start)) || 
          (powered.has(start) && grounded.has(start) && powered.has(end) && grounded.has(end))) {
        activeIds.add(item.id);
      }
    };

    wires.forEach(checkActive);
    leds.forEach(checkActive);
    resistors.forEach(checkActive);

    return activeIds;

  }, [wires, leds, resistors, pinStates]);

  const isActive = (id) => activeComponents.has(id);

  // --- UI制御周り ---
  useEffect(() => {
    const saved = localStorage.getItem('pico_sim_data_v3');
    if (saved) {
      try {
        const data = JSON.parse(saved);
        setWires(data.wires || []); setLeds(data.leds || []); setResistors(data.resistors || []); setCode(data.code || "");
      } catch(e) {}
    }
  }, []);
  useEffect(() => {
    localStorage.setItem('pico_sim_data_v3', JSON.stringify({ wires, leds, resistors, code }));
  }, [wires, leds, resistors, code]);

  const saveToFile = () => {
    const blob = new Blob([JSON.stringify({ wires, leds, resistors, code }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'pico_circuit.json'; a.click();
  };
  const loadFromFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = (ev) => {
      try {
        const d = JSON.parse(ev.target.result);
        setWires(d.wires); setLeds(d.leds); setResistors(d.resistors); setCode(d.code);
      } catch(e) { alert("Error"); }
    };
    r.readAsText(file);
  };
  const clearCircuit = () => { if(window.confirm("Clear circuit?")) { setWires([]); setLeds([]); setResistors([]); } };
  const clearCode = () => { if(window.confirm("Clear code?")) setCode(""); };

  const startEdit = (item, type) => {
    setEditingId(item.id); setEditType(type);
    if (type === 'wire') setInputWire({ sR: item.sR, sC: item.sC, eR: item.eR, eC: item.eC, color: item.color });
    if (type === 'led') setInputLed({ sR: item.sR, sC: item.sC, eR: item.eR, eC: item.eC });
    if (type === 'resistor') setInputResistor({ sR: item.sR, sC: item.sC, eR: item.eR, eC: item.eC, scale: item.scale, ohms: item.ohms });
  };
  const cancelEdit = () => { setEditingId(null); setEditType(null); };
  const addOrUpdateWire = () => {
    const newData = { ...inputWire, sR: Number(inputWire.sR), sC: Number(inputWire.sC), eR: Number(inputWire.eR), eC: Number(inputWire.eC) };
    if (editingId && editType === 'wire') { setWires(wires.map(w => w.id === editingId ? { ...w, ...newData } : w)); setEditingId(null); }
    else setWires([...wires, { ...newData, id: Date.now(), level: 2 }]);
  };
  const addOrUpdateLed = () => {
    const newData = { ...inputLed, sR: Number(inputLed.sR), sC: Number(inputLed.sC), eR: Number(inputLed.eR), eC: Number(inputLed.eC) };
    if (editingId && editType === 'led') { setLeds(leds.map(l => l.id === editingId ? { ...l, ...newData } : l)); setEditingId(null); }
    else setLeds([...leds, { ...newData, id: Date.now() }]);
  };
  const addOrUpdateResistor = () => {
    const newData = { ...inputResistor, sR: Number(inputResistor.sR), sC: Number(inputResistor.sC), eR: Number(inputResistor.eR), eC: Number(inputResistor.eC), scale: Number(inputResistor.scale), ohms: Number(inputResistor.ohms) };
    if (editingId && editType === 'resistor') { setResistors(resistors.map(r => r.id === editingId ? { ...r, ...newData } : r)); setEditingId(null); }
    else setResistors([...resistors, { ...newData, id: Date.now() }]);
  };
  const removeWire = (id) => setWires(wires.filter(w => w.id !== id));
  const removeLed = (id) => setLeds(leds.filter(l => l.id !== id));
  const removeResistor = (id) => setResistors(resistors.filter(r => r.id !== id));
  const handleHoleClick = (row, col) => setSelectedHole({ row, col });
  const setFromSelection = (type, field) => {
    if (!selectedHole) return;
    if (type === 'wire') setInputWire(prev => ({ ...prev, [field + 'R']: selectedHole.row, [field + 'C']: selectedHole.col }));
    else if (type === 'led') setInputLed(prev => ({ ...prev, [field + 'R']: selectedHole.row, [field + 'C']: selectedHole.col }));
    else if (type === 'resistor') setInputResistor(prev => ({ ...prev, [field + 'R']: selectedHole.row, [field + 'C']: selectedHole.col }));
  };
  const startHorizontalResize = useCallback((e) => { e.preventDefault(); const startX = e.clientX; const startWidth = leftPanelWidth; const onMouseMove = (moveEvent) => setLeftPanelWidth(Math.max(300, Math.min(800, startWidth + (moveEvent.clientX - startX)))); const onMouseUp = () => { document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp); }; document.addEventListener('mousemove', onMouseMove); document.addEventListener('mouseup', onMouseUp); }, [leftPanelWidth]);
  const startVerticalResize = useCallback((e) => { e.preventDefault(); const startY = e.clientY; const startHeight = editorHeight; const onMouseMove = (moveEvent) => setEditorHeight(Math.max(200, Math.min(window.innerHeight - 200, startHeight + (moveEvent.clientY - startY)))); const onMouseUp = () => { document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp); }; document.addEventListener('mousemove', onMouseMove); document.addEventListener('mouseup', onMouseUp); }, [editorHeight]);

  return (
    <div style={{ height: '100vh', display: 'flex', overflow: 'hidden' }}>
      <div style={{ width: leftPanelWidth, display: 'flex', flexDirection: 'column', background: '#1e1e1e', color: '#fff' }}>
        {/* Editor Area */}
        <div style={{ height: editorHeight, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '10px', background: '#007acc', fontWeight: 'bold' }}>Selected: {selectedHole ? `Row ${selectedHole.row}, Col ${selectedHole.col}` : "(Click a hole)"}</div>
          <div style={{ padding: '5px 10px', background: '#333', display: 'flex', gap: '10px', fontSize:'12px', alignItems:'center', flexWrap:'wrap' }}>
            <button onClick={saveToFile} style={{cursor:'pointer'}}>💾 Save</button>
            <label style={{cursor:'pointer', background:'#555', padding:'2px 5px', borderRadius:'3px'}}>📂 Load <input type="file" accept=".json" onChange={loadFromFile} style={{display:'none'}} /></label>
            <span style={{width:'1px', height:'15px', background:'#666'}}></span>
            <button onClick={clearCircuit} style={{cursor:'pointer', color:'#ff9999'}}>🗑 Clear Circuit</button>
            <button onClick={clearCode} style={{cursor:'pointer', color:'#ff9999'}}>📄 Clear Code</button>
          </div>
          <div style={{ padding: '10px', background: '#252526', display: 'flex', gap: '10px' }}>
            <button onClick={() => run(code)} disabled={!ready} style={{ background: 'green', color: 'white', padding: '8px 20px', border:'none', cursor:'pointer', fontWeight:'bold', borderRadius:'4px' }}>▶ Run</button>
            <button onClick={stop} style={{ background: 'red', color: 'white', padding: '8px 20px', border:'none', cursor:'pointer', fontWeight:'bold', borderRadius:'4px' }}>■ Stop</button>
          </div>
          <textarea value={code} onChange={(e) => setCode(e.target.value)} spellCheck="false" style={{ flex: 1, background: '#111', color: '#eee', border: 'none', padding: '15px', resize: 'none', fontFamily: 'Consolas, monospace', fontSize: '14px', outline: 'none' }} />
          <div style={{ height: '100px', background: '#000', padding: '10px', fontSize: '12px', overflowY: 'auto', fontFamily: 'monospace', borderTop: '1px solid #444' }}>{logs.map((l, i) => <div key={i}>{l}</div>)}</div>
        </div>
        <div onMouseDown={startVerticalResize} style={{ height: '5px', background: '#444', cursor: 'row-resize', width: '100%', borderTop: '1px solid #333', borderBottom: '1px solid #333' }}></div>
        
        {/* Component Builders */}
        <div style={{ flex: 1, overflowY: 'auto', background: '#1e1e1e' }}>
          <div style={{ padding: '15px' }}>
            {/* Wire Builder */}
            <div style={{ marginBottom: '20px' }}>
              <div style={{ fontWeight: 'bold', marginBottom: '8px', color:'#4ec9b0', display:'flex', justifyContent:'space-between' }}>⚡ Jumper Wires {editingId && editType==='wire' && <button onClick={cancelEdit} style={{fontSize:'10px'}}>Cancel Edit</button>}</div>
              <div style={{ display: 'flex', gap: '5px', marginBottom:'5px' }}><input type="number" placeholder="SR" value={inputWire.sR} onChange={e=>setInputWire({...inputWire, sR:e.target.value})} style={{width:'35px'}}/><input type="number" placeholder="SC" value={inputWire.sC} onChange={e=>setInputWire({...inputWire, sC:e.target.value})} style={{width:'35px'}}/><button onClick={() => setFromSelection('wire', 's')} style={{fontSize:'10px'}}>Set</button><span style={{color:'#888'}}>→</span><input type="number" placeholder="ER" value={inputWire.eR} onChange={e=>setInputWire({...inputWire, eR:e.target.value})} style={{width:'35px'}}/><input type="number" placeholder="EC" value={inputWire.eC} onChange={e=>setInputWire({...inputWire, eC:e.target.value})} style={{width:'35px'}}/><button onClick={() => setFromSelection('wire', 'e')} style={{fontSize:'10px'}}>Set</button></div>
              <div style={{display:'flex', gap:'5px'}}><select value={inputWire.color} onChange={e=>setInputWire({...inputWire, color:e.target.value})} style={{flex:1}}><option value="green">Green</option><option value="black">Black</option><option value="red">Red</option><option value="blue">Blue</option><option value="yellow">Yellow</option></select><button onClick={addOrUpdateWire} style={{background: editingId && editType==='wire' ? 'orange':'#eee', color:'black', border:'none', cursor:'pointer'}}>{editingId && editType==='wire' ? 'Update' : 'Add'}</button></div>
              <div style={{ marginTop: '5px', fontSize: '11px', maxHeight: '80px', overflowY: 'auto', background:'#222', padding:'5px' }}>{wires.map(w => (<div key={w.id} style={{ display: 'flex', justifyContent: 'space-between', marginBottom:'2px', background: editingId===w.id ? '#444': 'transparent' }}><span>{w.color}: {w.sR},{w.sC}→{w.eR},{w.eC}</span><div><button onClick={() => startEdit(w, 'wire')} style={{marginRight:'5px', cursor:'pointer'}}>✎</button><button onClick={() => removeWire(w.id)} style={{color:'red', cursor:'pointer'}}>x</button></div></div>))}</div>
            </div>
            {/* LED Builder */}
            <div style={{ marginBottom: '20px' }}>
              <div style={{ fontWeight: 'bold', marginBottom: '8px', color:'#ce9178', display:'flex', justifyContent:'space-between' }}>💡 LEDs {editingId && editType==='led' && <button onClick={cancelEdit} style={{fontSize:'10px'}}>Cancel Edit</button>}</div>
              <div style={{ display: 'flex', gap: '5px', marginBottom: '5px' }}><input type="number" placeholder="SR" value={inputLed.sR} onChange={e=>setInputLed({...inputLed, sR:e.target.value})} style={{width:'35px'}}/><input type="number" placeholder="SC" value={inputLed.sC} onChange={e=>setInputLed({...inputLed, sC:e.target.value})} style={{width:'35px'}}/><button onClick={() => setFromSelection('led', 's')} style={{fontSize:'10px'}}>Set</button><span style={{color:'#888'}}>→</span><input type="number" placeholder="ER" value={inputLed.eR} onChange={e=>setInputLed({...inputLed, eR:e.target.value})} style={{width:'35px'}}/><input type="number" placeholder="EC" value={inputLed.eC} onChange={e=>setInputLed({...inputLed, eC:e.target.value})} style={{width:'35px'}}/><button onClick={() => setFromSelection('led', 'e')} style={{fontSize:'10px'}}>Set</button><button onClick={addOrUpdateLed} style={{background: editingId && editType==='led' ? 'orange':'#eee', color:'black', border:'none', cursor:'pointer'}}>{editingId && editType==='led' ? 'Update' : 'Add'}</button></div>
              <div style={{ fontSize: '11px', maxHeight: '60px', overflowY: 'auto', background:'#222', padding:'5px' }}>{leds.map(l => (<div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', background: editingId===l.id ? '#444': 'transparent' }}><span>LED: {l.sR},{l.sC}→{l.eR},{l.eC}</span><div><button onClick={() => startEdit(l, 'led')} style={{marginRight:'5px', cursor:'pointer'}}>✎</button><button onClick={() => removeLed(l.id)} style={{color:'red', cursor:'pointer'}}>x</button></div></div>))}</div>
            </div>
            {/* Resistor Builder */}
            <div>
              <div style={{ fontWeight: 'bold', marginBottom: '8px', color:'#dcdcaa', display:'flex', justifyContent:'space-between' }}>📏 Resistors {editingId && editType==='resistor' && <button onClick={cancelEdit} style={{fontSize:'10px'}}>Cancel Edit</button>}</div>
               <div style={{ display: 'flex', gap: '5px', marginBottom: '5px', alignItems:'center' }}><input type="number" placeholder="SR" value={inputResistor.sR} onChange={e=>setInputResistor({...inputResistor, sR:e.target.value})} style={{width:'35px'}}/><input type="number" placeholder="SC" value={inputResistor.sC} onChange={e=>setInputResistor({...inputResistor, sC:e.target.value})} style={{width:'35px'}}/><button onClick={() => setFromSelection('resistor', 's')} style={{fontSize:'10px'}}>Set</button><span style={{color:'#888'}}>→</span><input type="number" placeholder="ER" value={inputResistor.eR} onChange={e=>setInputResistor({...inputResistor, eR:e.target.value})} style={{width:'35px'}}/><input type="number" placeholder="EC" value={inputResistor.eC} onChange={e=>setInputResistor({...inputResistor, eC:e.target.value})} style={{width:'35px'}}/><button onClick={() => setFromSelection('resistor', 'e')} style={{fontSize:'10px'}}>Set</button><input type="number" step="0.1" value={inputResistor.scale} onChange={e=>setInputResistor({...inputResistor, scale:e.target.value})} style={{width:'30px'}} placeholder="Sz"/><button onClick={addOrUpdateResistor} style={{background: editingId && editType==='resistor' ? 'orange':'#eee', color:'black', border:'none', cursor:'pointer'}}>{editingId && editType==='resistor' ? 'Update' : 'Add'}</button></div>
               <div style={{ fontSize: '11px', maxHeight: '60px', overflowY: 'auto', background:'#222', padding:'5px' }}>{resistors.map(r => (<div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', background: editingId===r.id ? '#444': 'transparent' }}><span>Res: {r.sR},{r.sC}→{r.eR},{r.eC} ({r.ohms}Ω)</span><div><button onClick={() => startEdit(r, 'resistor')} style={{marginRight:'5px', cursor:'pointer'}}>✎</button><button onClick={() => removeResistor(r.id)} style={{color:'red', cursor:'pointer'}}>x</button></div></div>))}</div>
            </div>
          </div>
        </div>
      </div>
      <div onMouseDown={startHorizontalResize} style={{ width: '5px', background: '#444', cursor: 'col-resize', height: '100%', borderLeft: '1px solid #333', borderRight: '1px solid #333' }}></div>
      
      {/* 3D View */}
      <div style={{ flex: 1, background: '#111' }}>
        <Canvas camera={{ position: [5, 12, 5], fov: 45 }}>
          <color attach="background" args={['#222']} />
          <ambientLight intensity={0.6} />
          <directionalLight position={[5, 10, 5]} intensity={1} />
          <OrbitControls makeDefault target={[0, 0, 0]} />
          <Breadboard onHoleClick={handleHoleClick} selectedHole={selectedHole} />
          <Pico pinStates={pinStates} />
          {wires.map(w => <CleanWire key={w.id} item={w} hasCurrent={isActive(w.id)} setHoverInfo={setHoverInfo} />)}
          {leds.map(l => <LEDComponent key={l.id} item={l} hasCurrent={isActive(l.id)} setHoverInfo={setHoverInfo} />)}
          {resistors.map(r => <ResistorComponent key={r.id} item={r} hasCurrent={isActive(r.id)} setHoverInfo={setHoverInfo} />)}
          {hoverInfo && <Tooltip position={hoverInfo.pos} text={hoverInfo.text} />}
        </Canvas>
      </div>
    </div>
  );
}