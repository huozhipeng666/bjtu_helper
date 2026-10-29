import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { buzz } from '../lib/haptics'
import { centersEqual } from '../lib/measure'

interface NavItem {
  key: string
  label: string
  icon: React.ReactNode
  /** 角标数字（未读站内信）。0 / undefined = 不显示 */
  badge?: number
}

interface NavBarProps {
  items: NavItem[]
  active: string
  onChange: (key: string) => void
  /** 再次点按当前 tab：刷新本页面（App 层重拉数据 + 回顶） */
  onActiveReselect?: () => void
}

/** 水滴宽/高 / 长按判定时长 / 按住后触发液态的位移阈值（放大在 CSS ::before 上做） */
const DROP_W = 58
/* 260ms 而不是更短：普通点按（尤其手指按下去那一下）本来就常常超过 200ms，
   阈值定太低会让"每一次慢一点的点击"都误入液态态，水珠无端胀大一次。
   260ms 仍是"一按就觉得快"的量级，但已经越过了 iPhone/安卓默认的触摸抖动窗口。 */
const LONG_PRESS_MS = 260
/* 12px 而不是 6px：触摸事件天然带几个像素的抖动，6px 门槛意味着几乎每次点按
   都会先被判成"横移"而强制进入液态。12px 刚好在"抖动"和"我想横着滑"之间。 */
const MOVE_THRESHOLD = 12

/* ============================================================
   水珠弹簧参数（质量恒为 1，即 a = -k·(x - target) - c·v）

   ζ = c / (2√k) 是阻尼比：
     SPRING_REST  k=330 c=20 → ω≈18.2rad/s，ζ≈0.55
       略欠阻尼。落位时会明显"冲过头一点再弹回来"，而且只弹一次就收住。
       这是液体感的关键：临界阻尼（ζ=1）虽然干净，看起来却像被磁铁拖过去的方块。
       周期约 0.35s，整体感觉 ≈0.45s 收尾，比原先那条固定的
       `transition: transform .5s cubic-bezier(.34,1.56,.64,1)` 更短也更"活"：
       原曲线只有一个固定过冲量，跟跳一格还是跳三格完全无关。
     SPRING_DRAG  k=1500 c=72 → ζ≈0.93
       跟手用。几乎不过冲，但保留半拍延迟 —— 手指快速划过时水珠会"被拖住"，
       这种滞后正是液体和光标的区别。
     SPRING_TAIL  k=150 c=22 → ω≈12.2，ζ≈0.90
       拖尾水珠。比主珠软得多，落后十几个像素，划动时在身后留一道液痕。
   ============================================================ */
const SPRING_REST = { k: 330, c: 20 }
const SPRING_DRAG = { k: 1500, c: 72 }
const SPRING_TAIL = { k: 150, c: 22 }
const SPRING_TAIL_DRAG = { k: 90, c: 20 }

interface Spring {
  x: number
  v: number
  target: number
  k: number
  c: number
  /** 上一帧的加速度（px/s²）。只被 paint() 读来做"撞停挤压"，不参与积分本身 */
  a: number
}

/** 系统开了「减少动态效果」时，弹簧退化成"直接落位" */
function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    /* 极老的 WebView 没有 matchMedia：按"正常动效"处理，弹簧本身不会出错 */
    return false
  }
}

/**
 * 「液态水滴」底栏（B 站 TV 版样式 · 弹簧物理版）：
 *
 * - 常态：激活 tab 背后一枚微方水珠（缓慢呼吸形变），切换时**按弹簧曲线**滑过去，
 *   速度越快形变越大（横向拉长 + 纵向压扁 + 轻微切变），落位时回头弹一下
 * - 拖尾：主珠身后跟一枚更软更慢的小水珠，只在两者拉开距离时显形，像一道液痕
 * - 磁吸：水珠靠近某个 tab 时，那个 tab 的图标会被"吸"起来一点（位移+放大）
 * - 点按：按下处扩散一圈涟漪；切换成功时落点再打一圈冲击波环
 * - 长按（260ms）或按住后横移超过 12px：进入液态——水珠放大跟随手指、栏体微微抬起，
 *   压到哪个 tab 哪个 tab 预览高亮；松手切换到该 tab，水珠带(松手速度)甩过去
 *
 * 手势基于 Pointer Events（鼠标/触屏通用），move/up 监听挂 window；
 * contextmenu 一律屏蔽（安卓长按弹菜单会把页面"卡住"）。
 *
 * 为什么位置走 rAF + ref 而不是 CSS transition / React state：
 *   1. CSS 过渡的过冲量是固定的，短距离和长距离看起来一样"猛"，
 *      而且没法根据松手速度决定甩多远 —— 这两点决定了它做不出液体感；
 *   2. 拖拽时每次 pointermove 都 setState 会让整个底栏（4 个 button + 图标）
 *      重渲染，恰好是在最需要流畅的时刻。现在拖拽期间 React 只在"压着的 tab 变了"
 *      时才渲染一次。
 */
export default function NavBar({ items, active, onChange, onActiveReselect }: NavBarProps) {
  const barRef = useRef<HTMLElement>(null)
  const dropRef = useRef<HTMLSpanElement>(null)
  const tailRef = useRef<HTMLSpanElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [activeIdx, setActiveIdx] = useState(() => Math.max(0, items.findIndex((i) => i.key === active)))
  const [centers, setCenters] = useState<number[]>([])
  const [barWidth, setBarWidth] = useState(0)
  /**
   * 液态拖拽中：只记"压在哪个 tab 上"。
   * 水珠位置本身走 ref + rAF，不进 React 状态 —— 见组件头注释。
   */
  const [liquid, setLiquid] = useState<{ over: number } | null>(null)
  /** 点按涟漪（wave=false）/ 落位冲击波（wave=true），坐标相对栏左缘 */
  const [ripples, setRipples] = useState<{ id: number; x: number; wave: boolean }[]>([])
  const rippleSeq = useRef(0)

  /** 当前按住的手势（一次只允许一个） */
  const pressRef = useRef<{
    id: number
    startX: number
    engaged: boolean
    lastX: number
    lastT: number
    vx: number
    timer?: number
  } | null>(null)
  /** 当前按住的那一格（-1 表示没有）：松手/进入液态时靠它把 --press 收回 */
  const prevPressRef = useRef(-1)
  /** measure/activeIdx/liquid 的最新值，供 window 级事件回调与 rAF 读取 */  const stateRef = useRef({ centers, barWidth, activeIdx, over: -1 })
  stateRef.current = { centers, barWidth, activeIdx, over: liquid ? liquid.over : -1 }
  const windowHandlersRef = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void; cancel: (e: PointerEvent) => void } | null>(null)

  /** 两枚水珠的物理状态 + rAF 句柄（整场动画只有这一处可变状态） */
  const anim = useRef({
    main: { x: 0, v: 0, target: 0, k: SPRING_REST.k, c: SPRING_REST.c, a: 0 } as Spring,
    tail: { x: 0, v: 0, target: 0, k: SPRING_TAIL.k, c: SPRING_TAIL.c, a: 0 } as Spring,
    raf: 0,
    last: 0,
    /** 液态拖拽中：形变幅度要收着点（此时 ::before 已经放大到 1.32 倍了） */
    liquid: false,
    /** 手指按住未抬起：水珠被压扁一点（只喂给 --drop-scale，不参与逐帧形变） */
    pressing: false,
    /** 首帧是否已经落位（首帧要"瞬移"到激活 tab，不能从栏左缘滑进来） */
    placed: false
  })

  /* 水珠本体的「离散缩放」（按压 0.945 / 常态 1 / 液态 1.32）不在这里用状态存：
     它由 paint() 直接写成 --drop-scale，交给 ::before 的 transform + transition 处理。
     为什么不用 className：<nav> 的 className 是 React 管的，而拖拽开始/结束恰好会
     触发一次重渲染（nav-liquid 要挂上去）—— React 写回 className 时会把手动加的
     class 一并抹掉，于是"按下的压扁"会随机丢失。CSS 变量则完全在 React 视野之外。 */

  /** 按下 / 松手时给被按的那一格写 --press（0 / 1）：图标微缩一点点 */
  const setPress = useCallback((idx: number, on: boolean) => {
    tabRefs.current[idx]?.style.setProperty('--press', on ? '1' : '0')
  }, [])

  const measure = useCallback(() => {
    const bar = barRef.current
    if (!bar) return
    const barRect = bar.getBoundingClientRect()
    const nextCenters = tabRefs.current.map((el) => {
      if (!el) return 0
      const r = el.getBoundingClientRect()
      return r.left - barRect.left + r.width / 2
    })
    /* 去重再写状态：resize / ResizeObserver / 旋转屏幕的回调会连着来好几发，
       而 setCenters 每次传的都是**新数组**——即使数值一个都没变也会触发重渲染，
       连带水下那道水滴重算 roundRect。这里用 subpixel 容差比一次，
       没变就整个跳过一次提交。 */
    setBarWidth((prev) => (Math.abs(prev - barRect.width) < 0.5 ? prev : barRect.width))
    setCenters((prev) => (centersEqual(prev, nextCenters) ? prev : nextCenters))
  }, [])

  const clampX = useCallback((x: number) => {
    const half = DROP_W / 2
    const max = Math.max(half, stateRef.current.barWidth - half)
    return Math.max(half, Math.min(x, max))
  }, [])

  const nearestIdx = useCallback((x: number) => {
    const cs = stateRef.current.centers
    let best = 0
    let bestD = Infinity
    cs.forEach((c, i) => {
      const d = Math.abs(c - x)
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }, [])

  /* ---------------- 每一帧的画面 ----------------
     只写 transform 与 CSS 变量，不碰任何会触发重排的属性：
       · 水珠：translate3d + skewX + scale（合成层内完成，不重排）
       · 拖尾：translate3d + scale + opacity
       · 每个 tab：一个 --near 变量（0~1），由 CSS 换算成图标的磁吸位移 */
  const paint = useCallback(() => {
    const a = anim.current
    const x = clampX(a.main.x)
    const v = a.main.v

    const drop = dropRef.current
    if (drop) {
      /* 速度 → 形变。横拉、竖压、切变三个量都由同一个 speed 派生，
         保证它们永远同步：只要有一点不同步，观感就从"液体被甩出去"变成"图在抽搐"。 */
      const speed = Math.min(1, Math.abs(v) / (a.liquid ? 3000 : 2400))
      const dir = v < 0 ? -1 : 1
      /* 撞停挤压：弹簧在「快要到位、但仍带着速度」那几帧的加速度最大 ——
         也就是液体真正撞上目标位置的那一下。单靠速度驱动时，最"硬"的
         那一下恰恰发生在速度已经接近 0 的时候，看上去是"轻轻飘到"而不是"撞上"。
         补一个跟 |a| 走的压缩项，才有"啪"地贴住再回弹的质感。 */
      const impact = Math.min(1, Math.abs(a.main.a) / 5200) * (a.liquid ? 0 : 1)
      const sx = 1 + speed * (a.liquid ? 0.16 : 0.3) + impact * 0.075
      const sy = 1 - speed * 0.12 - impact * 0.058
      const skew = -dir * speed * 6.5
      drop.style.transform =
        `translate3d(${(x - DROP_W / 2).toFixed(2)}px, 0, 0) ` +
        `skewX(${skew.toFixed(2)}deg) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`
      /* 本体的离散缩放走 CSS 变量：按压 0.945（被指腹压下去）、液态 1.32（胀成透镜）、
         常态 1。写在 ::before 的 transform 里，和上面的逐帧形变是两个独立层，
         所以"跟随手指甩动"和"按下变扁"可以同时发生。 */
      drop.style.setProperty('--drop-scale', (a.liquid ? 1.32 : a.pressing ? 0.945 : 1).toFixed(3))
      /* 速度光晕：只在高速掠过时亮起，静止时是 0（完全不渲染那层模糊） */
      drop.style.setProperty('--drop-glow', (speed * (a.liquid ? 0.45 : 1)).toFixed(3))
    }

    const tail = tailRef.current
    if (tail) {
      const tx = clampX(a.tail.x)
      const gap = Math.abs(tx - x)
      /* 只有被拉开距离时才显形：贴合时它必须彻底消失，否则水珠边缘会糊出一圈毛边 */
      const tint = Math.min(1, gap / 30)
      tail.style.transform = `translate3d(${(tx - DROP_W / 2).toFixed(2)}px, 0, 0) scale(${(0.62 + tint * 0.3).toFixed(3)})`
      tail.style.opacity = (tint * 0.5).toFixed(3)
    }

    const cs = stateRef.current.centers
    const bw = stateRef.current.barWidth
    if (cs.length > 0 && bw > 0) {
      const span = bw / cs.length
      /* 磁吸半径刻意收窄到 0.62 个格距：
         用满格距（1.0）时，水珠停在任何一格，左右相邻两格都会被挂上位移 ——
         单看一格察觉不到，但四个图标整体就永远"没完全落下去"，底栏显得脏。
         0.62 让水珠停稳时相邻格严格回到 0。
         穿透力用二次曲线（t² 而非线性），近处陡、远处平，更像磁铁：
         水珠刚进邻格边缘时几乎没反应，靠近时才被"刷"地吸上来。 */
      const R = span * 0.62
      const { activeIdx: cur, over } = stateRef.current
      for (let i = 0; i < cs.length; i++) {
        const el = tabRefs.current[i]
        if (!el) continue
        /* 激活中 / 正被水珠压住的 tab 自己不参与磁吸：
           它们已经有 active / over 那套更强的抬升，叠加只会让图标顶到栏外 */
        const t = i === cur || i === over ? 0 : Math.max(0, 1 - Math.abs(cs[i] - x) / R)
        const near = t * t
        el.style.setProperty('--near', near.toFixed(3))
        /* 单位必须显式带上：CSS 那边是 translateX(var(--push))，
           给定无单位数值会整条 transform 失效（静默地，不报错、只是不动）。 */
        const push = t === 0 ? 0 : Math.sign(cs[i] - x) * t * 2.4
        el.style.setProperty('--push', push.toFixed(2) + 'px')
      }
    }
  }, [clampX])

  /** 一帧的定步长积分。dt 上限 34ms：切后台回来时 timeStamp 会跳很大，
      不夹住的话弹簧会在一帧里算出巨大位移，水珠直接"瞬移"到别处。 */
  const loop = useCallback(
    (t: number) => {
      const a = anim.current
      const dt = Math.min(0.034, Math.max(0.006, (t - a.last) / 1000))
      a.last = t
      let moving = false
      for (const sp of [a.main, a.tail]) {
        const accel = -sp.k * (sp.x - sp.target) - sp.c * sp.v
        sp.a = accel
        sp.v += accel * dt
        sp.x += sp.v * dt
        if (Math.abs(sp.v) > 0.5 || Math.abs(sp.x - sp.target) > 0.3) moving = true
        else {
          sp.x = sp.target
          sp.v = 0
        }
      }
      paint()
      if (moving) {
        a.raf = requestAnimationFrame(loop)
      } else {
        a.raf = 0
        /* 停下来了：把图层提升还回去（下一帧就要重绘，这时撤掉正好不亏） */
        if (dropRef.current) dropRef.current.style.willChange = ''
        if (tailRef.current) tailRef.current.style.willChange = ''
      }
    },
    [paint]
  )

  const kick = useCallback(() => {
    const a = anim.current
    if (a.raf) return
    if (prefersReducedMotion()) {
      a.main.x = a.main.target
      a.tail.x = a.tail.target
      a.main.v = 0
      a.tail.v = 0
      paint()
      return
    }
    /* 图层提升只在水珠真正运动的这段时间里挂着。
       直接写内联 style 而不是挂 class：<nav> 的 className 由 React 管，
       每次重渲染（切换时一定会发生）都会把它写回去，手动加的 class 会被抹掉；
       而这两个 span 的 style 没有任何 React 属性在管，写进去就不会被别人覆盖。
       静止时立刻撤掉 —— 底栏是常驻组件，常驻的 will-change 等于永久占一块图层内存。 */
    if (dropRef.current) dropRef.current.style.willChange = 'transform'
    if (tailRef.current) tailRef.current.style.willChange = 'transform'
    a.last = performance.now()
    a.raf = requestAnimationFrame(loop)
  }, [loop, paint])

  /** 设定目标并起跑。mode 只决定"用哪套弹簧参数"（跟手 vs 落位） */
  const aim = useCallback(
    (x: number, mode: 'rest' | 'drag') => {
      const a = anim.current
      const main = mode === 'drag' ? SPRING_DRAG : SPRING_REST
      const tail = mode === 'drag' ? SPRING_TAIL_DRAG : SPRING_TAIL
      a.main.target = x
      a.tail.target = x
      a.main.k = main.k
      a.main.c = main.c
      a.tail.k = tail.k
      a.tail.c = tail.c
      kick()
    },
    [kick]
  )

  useLayoutEffect(() => {
    measure()
  }, [measure, items.length])

  useEffect(() => {
    window.addEventListener('resize', measure)
    window.addEventListener('orientationchange', measure)
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined' && barRef.current) {
      ro = new ResizeObserver(() => measure())
      ro.observe(barRef.current)
      tabRefs.current.forEach((el) => el && ro!.observe(el))
    }
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('orientationchange', measure)
      ro?.disconnect()
    }
  }, [measure])

  // 程序化切 tab（返回键、从个人中心跳帖子等）时同步水滴位置
  useEffect(() => {
    const idx = items.findIndex((i) => i.key === active)
    if (idx >= 0) setActiveIdx(idx)
  }, [active, items])

  /** 静止目标：吸附激活 tab；首帧测量完成前先躲在栏中央（此时 .is-ready 还没挂上，不可见） */
  const measured = centers.length === items.length && barWidth > 0
  const restX = measured && centers[activeIdx] !== undefined ? centers[activeIdx] : barWidth / 2

  // 目标位置变化 → 起跑（拖拽期间由指针直接驱动，这里不插手）
  useLayoutEffect(() => {
    if (!measured) return
    const a = anim.current
    if (!a.placed) {
      /* 首帧：不播动画，直接落位。否则每次进应用水珠都会从栏左缘滑到「本周」上，
         看起来像一次莫名其妙的切换。 */
      a.placed = true
      a.main.x = a.tail.x = a.main.target = a.tail.target = restX
      a.main.v = a.tail.v = 0
      paint()
      return
    }
    if (liquid) return
    aim(restX, 'rest')
  }, [measured, restX, liquid, aim, paint])

  /* ---------------- 涟漪 ---------------- */
  const addRipple = useCallback((x: number, wave: boolean) => {
    rippleSeq.current += 1
    const id = rippleSeq.current
    setRipples((prev) => {
      const next = [...prev, { id, x, wave }]
      /* 只留最近 4 个：万一 animationend 因为页面被切到后台没触发（动画挂起），
         也不会无限堆积成一串没人清理的节点 */
      return next.length > 4 ? next.slice(next.length - 4) : next
    })
  }, [])

  const dropRipple = useCallback((id: number) => {
    setRipples((prev) => prev.filter((r) => r.id !== id))
  }, [])

  /* ---------------- 手势 ---------------- */

  /** 进入液态：先响一下，再放大水珠、把目标交给指针 */
  function engage(x: number) {
    buzz(6)
    anim.current.pressing = false
    anim.current.liquid = true
    /* 进入液态时把"按下微缩"收回：水珠已经胀起来了，压在格上的是水珠不是手指 */
    setPress(prevPressRef.current, false)
    prevPressRef.current = -1
    setLiquid({ over: nearestIdx(x) })
    aim(clampX(x), 'drag')
  }

  /** 松手结算：液态则切到水珠下的 tab；快速点按则等价普通点击（含当前 tab 刷新） */
  function settle(x: number, wasEngaged: boolean) {
    /* ⚠️ 必须最先读：调用方在 finish 里会清 pressRef，
       速度是"松手瞬间"的采样值，只能在这里先取一次。 */
    const releaseV = pressRef.current?.vx ?? 0
    const idx = nearestIdx(x)
    const cur = stateRef.current.activeIdx
    anim.current.liquid = false
    setLiquid(null)
    setPress(prevPressRef.current, false)
    prevPressRef.current = -1
    const restOf = (i: number) => clampX(stateRef.current.centers[i] ?? x)

    if (idx === cur) {
      // 原地长按松手 / 点按当前 tab：刷新本页面
      aim(restOf(cur), 'rest')
      if (!wasEngaged) buzz(4)
      onActiveReselect?.()
      return
    }
    if (!items[idx]) {
      aim(restOf(cur), 'rest')
      return
    }
    /* 把松手瞬间的速度交给弹簧：快速划过时水珠会"甩"过去再回弹，
       比匀速收敛更像被手指带出去的液体。上限 ±2600px/s，防止一次猛划把它扔出栏外。 */
    const a = anim.current
    a.main.v = Math.max(-2600, Math.min(2600, releaseV * 0.85))
    a.tail.v = a.main.v * 0.5
    setActiveIdx(idx)
    onChange(items[idx].key)
    aim(restOf(idx), 'rest')
    addRipple(restOf(idx), true)
    buzz(6)
  }

  /** 卸掉 window 级手势监听 */
  function releaseWindowHandlers() {
    const h = windowHandlersRef.current
    if (h) {
      window.removeEventListener('pointermove', h.move)
      window.removeEventListener('pointerup', h.up)
      window.removeEventListener('pointercancel', h.cancel)
      windowHandlersRef.current = null
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // 兜底：上一次手势若因异常没有收尾，先清干净，保证这次一定生效
    if (pressRef.current) {
      clearTimeout((pressRef.current as unknown as { timer?: number }).timer ?? 0)
      pressRef.current = null
      releaseWindowHandlers()
      setLiquid(null)
      anim.current.liquid = false
    }
    const bar = barRef.current
    if (!bar) return
    const barRect = bar.getBoundingClientRect()
    const downX = clampX(e.clientX - barRect.left)
    const pointerId = e.pointerId

    /* 按下即反馈：涟漪从指腹扩散 + 水珠被压扁一点 + 被按的那格图标微缩。
       三者都只走 ref / classList / CSS 变量，不进 React 状态 —— 点一下不额外渲染底栏。 */
    addRipple(downX, false)
    anim.current.pressing = true
    const pressedIdx = nearestIdx(downX)
    prevPressRef.current = pressedIdx
    setPress(pressedIdx, true)
    kick()

    const press: {
      id: number
      startX: number
      engaged: boolean
      lastX: number
      lastT: number
      vx: number
      timer?: number
    } = { id: pointerId, startX: e.clientX, engaged: false, lastX: downX, lastT: performance.now(), vx: 0 }
    press.timer = window.setTimeout(() => {
      // 长按到时：原地进入液态
      if (pressRef.current && pressRef.current.id === pointerId) {
        press.engaged = true
        engage(downX)
      }
    }, LONG_PRESS_MS)
    pressRef.current = press

    const move = (ev: PointerEvent) => {
      const p = pressRef.current
      if (!p || ev.pointerId !== p.id) return
      const x = clampX(ev.clientX - barRect.left)
      // 按住后横移超过阈值：不等长按，直接进入液态
      if (!p.engaged && Math.abs(ev.clientX - p.startX) > MOVE_THRESHOLD) {
        p.engaged = true
        clearTimeout(p.timer)
        engage(x)
      }
      if (p.engaged) {
        /* 速度采样（指数平滑）：事件间隔抖动很大，单次差分噪声会把水珠抖成锯齿 */
        const now = ev.timeStamp || performance.now()
        const dt = Math.max(8, now - p.lastT) / 1000
        const inst = (x - p.lastX) / dt
        p.vx = p.vx * 0.55 + inst * 0.45
        p.lastX = x
        p.lastT = now
        /* 位置直接进弹簧，不进 state：拖拽期不再逐帧重渲染底栏 */
        aim(x, 'drag')
        const over = nearestIdx(x)
        setLiquid((cur) => (cur && cur.over === over ? cur : { over }))
      }
    }
    const finish = (ev: PointerEvent, cancelled: boolean) => {
      const p = pressRef.current
      if (!p || ev.pointerId !== p.id) return
      clearTimeout(p.timer)
      releaseWindowHandlers()
      /* pressRef 要留到 settle 之后才清：settle 里要读 p.vx（松手瞬间的速度），
         提前清掉的话"甩出去"永远是 0，所有切换都退化成匀速收敛。 */
      anim.current.pressing = false
      if (cancelled) {
        pressRef.current = null
        anim.current.liquid = false
        setLiquid(null)
        setPress(prevPressRef.current, false)
        prevPressRef.current = -1
        kick()
        aim(clampX(stateRef.current.centers[stateRef.current.activeIdx] ?? 0), 'rest')
        return
      }
      settle(clampX(ev.clientX - barRect.left), p.engaged)
      pressRef.current = null
    }
    const up = (ev: PointerEvent) => finish(ev, false)
    const cancel = (ev: PointerEvent) => finish(ev, true)

    windowHandlersRef.current = { move, up, cancel }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  /**
   * 键盘 / 读屏触发的 click（detail === 0）走这里；
   * 指针产生的合成 click 一律忽略（点按已在 pointerup 结算过）。
   */
  function onNavClick(e: React.MouseEvent) {
    if (e.detail > 0) return
    const el = (e.target as HTMLElement).closest<HTMLElement>('.nav-tab')
    if (!el) return
    const idx = Number(el.dataset.index)
    if (!Number.isInteger(idx) || !items[idx]) return
    if (idx === stateRef.current.activeIdx) {
      onActiveReselect?.()
      return
    }
    setActiveIdx(idx)
    onChange(items[idx].key)
    addRipple(clampX(stateRef.current.centers[idx] ?? 0), true)
  }

  // 组件卸载时兜底清理（切页时 NavBar 不会卸载，保险起见）
  useEffect(
    () => () => {
      releaseWindowHandlers()
      const a = anim.current
      if (a.raf) cancelAnimationFrame(a.raf)
      a.raf = 0
    },
    []
  )

  return (
    <nav
      className={`bottom-nav glass-nav${measured ? ' is-ready' : ''}${liquid ? ' nav-liquid' : ''}`}
      ref={barRef}
      onPointerDown={onPointerDown}
      onClick={onNavClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 点按涟漪 / 落位冲击波：纯装饰，读屏忽略 */}
      <span className="nav-ripples" aria-hidden="true">
        {ripples.map((r) => (
          <span
            key={r.id}
            className={`nav-ripple${r.wave ? ' is-wave' : ''}`}
            style={{ left: `${r.x}px` }}
            onAnimationEnd={(e) => {
              if (e.target === e.currentTarget) dropRipple(r.id)
            }}
          />
        ))}
      </span>

      {/* 拖尾液痕（在主珠之下，先于它绘制） */}
      <span ref={tailRef} className="nav-drop-tail" aria-hidden="true" />

      {/* 水珠：位移/形变全部由 rAF 逐帧写 transform，见 paint() */}
      <span ref={dropRef} className={`nav-drop${liquid ? ' dragging' : ''}`} aria-hidden="true" />

      {items.map((ni, i) => {
        // 液态拖拽时原激活 tab 先"熄灭"，只亮水珠压着的那个（视觉焦点跟随水珠）
        const isActive = ni.key === active && !liquid
        const isOver = liquid?.over === i
        return (
          <button
            key={ni.key}
            ref={(el) => {
              tabRefs.current[i] = el
            }}
            data-index={i}
            className={`nav-tab${isActive ? ' active' : ''}${isOver ? ' over' : ''}`}
            aria-current={ni.key === active ? 'page' : undefined}
            /* 角标对读屏是隐藏的（视觉提示），所以把"有几条未读"补进按钮的可访问名 */
            aria-label={ni.badge !== undefined && ni.badge > 0 ? `${ni.label}（${ni.badge} 条未读）` : undefined}
          >
            {/* 外层 ico 只承担"磁吸"位移（逐帧写 --near），内层 glyph 承担"激活/预览"的
                弹跳 —— 两层分开，两套动画才不会互相覆盖 transform。 */}
            <span className="nav-tab-ico">
              <span className="nav-tab-glyph">{ni.icon}</span>
              {/* 未读角标：只显示数字，超过 9 就写 9+（底栏位置很小，两位数字会挤）
                  key 挂数字本身：数字一变就重挂载，入场动画自动重播（新消息有"跳一下"的提示） */}
              {ni.badge !== undefined && ni.badge > 0 && (
                <span className="nav-dot" aria-hidden="true" key={ni.badge}>
                  {ni.badge > 9 ? '9+' : ni.badge}
                </span>
              )}
            </span>
            <span className="nav-tab-label">{ni.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
