(() => {
    "use strict";

    const SIZE = 15;
    const EMPTY = 0, BLACK = 1, WHITE = 2;
    const SEARCH_TIME_MS = 2200;
    const MAX_DEPTH = 7;
    const board = new Int8Array(SIZE * SIZE);
    const goban = document.getElementById("goban");
    const statusEl = document.getElementById("turnStatus");
    const hintEl = document.getElementById("hintNote");
    const newGameBtn = document.getElementById("newGame");
    const resetBtn = document.getElementById("resetGame");

    let cells = [];
    let currentPlayer = BLACK;
    let moveCount = 0;
    let gameOver = false;
    let thinking = false;
    let lastMove = -1;
    let worker = null;
    let workerURL = null;
    let generation = 0;
    let fallbackTimer = null;

    const DIRECTIONS = [[1,0],[0,1],[1,1],[1,-1]];

    function setStatus(message, color) {
        statusEl.innerHTML = '<span class="dot"></span> ' + message;
        const dot = statusEl.querySelector(".dot");
        dot.style.background = color || "#4caf50";
        dot.style.boxShadow = "0 0 12px " + (color || "#4caf50");
    }

    function indexOf(x, y) { return y * SIZE + x; }
    function inBounds(x, y) { return x >= 0 && x < SIZE && y >= 0 && y < SIZE; }

    function createBoard() {
        goban.innerHTML = "";
        cells = new Array(SIZE * SIZE);
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                const i = indexOf(x, y);
                const cell = document.createElement("div");
                cell.className = "cell";
                if ([3, 7, 11].includes(x) && [3, 7, 11].includes(y)) cell.classList.add("star");
                cell.dataset.index = String(i);
                cell.setAttribute("role", "button");
                cell.setAttribute("tabindex", "0");
                cell.setAttribute("aria-label", `第${y+1}行，第${x+1}列，空位`);
                cell.addEventListener("click", () => playerMove(i));
                cell.addEventListener("keydown", e => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        playerMove(i);
                    }
                });
                goban.appendChild(cell);
                cells[i] = cell;
            }
        }
    }

    function renderCell(i) {
        const cell = cells[i];
        const value = board[i];
        cell.innerHTML = "";
        cell.classList.toggle("last-move", i === lastMove);
        if (value) {
            const piece = document.createElement("div");
            piece.className = "piece " + (value === BLACK ? "black" : "white");
            cell.appendChild(piece);
            cell.setAttribute("aria-label",
                `第${Math.floor(i / SIZE)+1}行，第${i%SIZE+1}列，${value === BLACK ? "黑棋" : "白棋"}`);
        } else {
            cell.setAttribute("aria-label",
                `第${Math.floor(i / SIZE)+1}行，第${i%SIZE+1}列，空位`);
        }
    }

    function place(i, player) {
        if (!Number.isInteger(i) || i < 0 || i >= board.length || board[i] !== EMPTY) return false;
        board[i] = player;
        moveCount++;
        const old = lastMove;
        lastMove = i;
        if (old >= 0 && old !== i) cells[old].classList.remove("last-move");
        renderCell(i);
        return true;
    }

    function countRay(x, y, dx, dy, player) {
        let count = 0, nx = x + dx, ny = y + dy;
        while (inBounds(nx, ny) && board[indexOf(nx, ny)] === player) {
            count++; nx += dx; ny += dy;
        }
        return count;
    }

    function isWin(i, player) {
        const x = i % SIZE, y = Math.floor(i / SIZE);
        for (const [dx, dy] of DIRECTIONS) {
            const n = 1 + countRay(x, y, dx, dy, player) +
                countRay(x, y, -dx, -dy, player);
            if (n >= 5) return true;
        }
        return false;
    }

    function finish(winner) {
        gameOver = true;
        thinking = false;
        stopSearch();
        if (winner === BLACK) {
            setStatus("你赢了！", "#4caf50");
            hintEl.textContent = "🎉 恭喜你获胜！";
        } else if (winner === WHITE) {
            setStatus("AI 获胜！", "#e74c3c");
            hintEl.textContent = "🤖 AI 获胜，再来一局吧！";
        } else {
            setStatus("平局！", "#f0ad4e");
            hintEl.textContent = "棋盘已满，双方平局。";
        }
    }

    function playerMove(i) {
        if (gameOver || thinking || currentPlayer !== BLACK) return;
        if (!place(i, BLACK)) return;
        if (isWin(i, BLACK)) return finish(BLACK);
        if (moveCount === SIZE * SIZE) return finish(0);

        currentPlayer = WHITE;
        thinking = true;
        setStatus("AI 思考中...", "#f0ad4e");
        hintEl.textContent = "🤖 AI 正在分析棋盘局势…";
        requestAIMove();
    }

    function requestAIMove() {
        const requestId = ++generation;
        const snapshot = Array.from(board);
        ensureWorker();

        if (worker) {
            try {
                worker.postMessage({
                    type: "search",
                    id: requestId,
                    board: snapshot,
                    player: WHITE,
                    maxTime: SEARCH_TIME_MS,
                    maxDepth: MAX_DEPTH
                });
                // 看门狗：Worker 若因浏览器/运行时异常没有返回，自动恢复可玩状态。
                if (fallbackTimer !== null) clearTimeout(fallbackTimer);
                fallbackTimer = setTimeout(() => {
                    if (requestId !== generation || gameOver || !thinking) return;
                    if (worker) worker.terminate();
                    worker = null;
                    if (workerURL) URL.revokeObjectURL(workerURL);
                    workerURL = null;
                    fallbackTimer = null;
                    scheduleFallback(requestId, Array.from(board));
                }, SEARCH_TIME_MS + 2500);
                return;
            } catch (_) {
                // 浏览器拒绝消息传递时，降级为合法着法兜底。
                if (worker) worker.terminate();
                worker = null;
                if (workerURL) URL.revokeObjectURL(workerURL);
                workerURL = null;
                if (fallbackTimer !== null) clearTimeout(fallbackTimer);
                fallbackTimer = null;
            }
        }

        scheduleFallback(requestId, snapshot);
    }

    function ensureWorker() {
        if (worker) return;
        if (!window.Worker || !window.Blob || !window.URL || !URL.createObjectURL) return;
        try {
            const source = "(" + workerMain.toString() + ")();";
            workerURL = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
            const instance = new Worker(workerURL);
            worker = instance;
            instance.onmessage = event => {
                if (worker !== instance) return;
                handleWorkerMessage(event.data);
            };
            instance.onerror = () => {
                // 忽略已被重置/替换的旧 Worker 错误事件。
                if (worker !== instance) return;
                generation++;
                if (fallbackTimer !== null) clearTimeout(fallbackTimer);
                fallbackTimer = null;
                instance.terminate();
                worker = null;
                if (workerURL) URL.revokeObjectURL(workerURL);
                workerURL = null;
                if (thinking && !gameOver) {
                    const id = generation;
                    scheduleFallback(id, Array.from(board));
                }
            };
        } catch (_) {
            worker = null;
            if (workerURL) URL.revokeObjectURL(workerURL);
            workerURL = null;
        }
    }

    function scheduleFallback(requestId, snapshot) {
        if (fallbackTimer !== null) clearTimeout(fallbackTimer);
        fallbackTimer = setTimeout(() => {
            fallbackTimer = null;
            if (requestId !== generation || gameOver || !thinking || currentPlayer !== WHITE) return;
            const move = simpleFallback(snapshot, WHITE);
            handleWorkerMessage({ type: "result", id: requestId, move });
        }, 0);
    }

    function stopSearch() {
        generation++;
        // Worker 正在执行同步搜索时无法及时处理 cancel 消息；
        // 直接 terminate 才能立即停止旧局面的计算，避免新一局排队等待。
        if (worker) {
            worker.terminate();
            worker = null;
        }
        if (workerURL) {
            URL.revokeObjectURL(workerURL);
            workerURL = null;
        }
        if (fallbackTimer !== null) {
            clearTimeout(fallbackTimer);
            fallbackTimer = null;
        }
    }

    function handleWorkerMessage(data) {
        if (!data || data.id !== generation || gameOver || !thinking) return;
        if (data.type === "progress") {
            if (data.depth) hintEl.textContent =
                `🤖 AI 思考中… 搜索深度 ${data.depth} · ${data.nodes || 0} 个节点`;
            return;
        }
        if (data.type !== "result") return;
        if (fallbackTimer !== null) {
            clearTimeout(fallbackTimer);
            fallbackTimer = null;
        }

        const move = data.move;
        if (!Number.isInteger(move) || move < 0 || move >= board.length || board[move] !== EMPTY) {
            // 若搜索结果异常，使用当前局面第一个合法空点，绝不重复落子。
            const legal = board.findIndex(v => v === EMPTY);
            if (legal < 0) return finish(0);
            applyAIMove(legal);
            return;
        }
        applyAIMove(move);
    }

    function applyAIMove(i) {
        if (!thinking || gameOver || currentPlayer !== WHITE || !place(i, WHITE)) return;
        if (isWin(i, WHITE)) return finish(WHITE);
        if (moveCount === SIZE * SIZE) return finish(0);
        currentPlayer = BLACK;
        thinking = false;
        setStatus("轮到你了", "#4caf50");
        hintEl.textContent = `第 ${moveCount} 手 · 请落子，黑棋先手`;
    }

    function resetGame() {
        stopSearch();
        board.fill(EMPTY);
        moveCount = 0;
        currentPlayer = BLACK;
        gameOver = false;
        thinking = false;
        lastMove = -1;
        for (let i = 0; i < cells.length; i++) renderCell(i);
        setStatus("轮到你了", "#4caf50");
        hintEl.textContent = "⚡ 你执黑棋 · AI执白棋 · 黑棋先手";
    }

    newGameBtn.addEventListener("click", resetGame);
    resetBtn.addEventListener("click", resetGame);

    // Worker 源码：独立线程中的迭代加深 + Alpha-Beta + Zobrist 置换表。
    // 使用函数自包含，避免产生第四个文件。
    function workerMain() {
        "use strict";
        const N = 15, E = 0, B = 1, W = 2;
        const DIRS = [[1,0],[0,1],[1,1],[1,-1]];
        const INF = 1e15, WIN = 1e12;
        let cancelled = false, activeId = 0;
        let deadline = 0, nodes = 0, maxDepth = 6;
        let board = new Int8Array(N * N);
        let hash = 0n;
        let zobrist = [];
        let table = new Map();
        let killer = [];
        let history = new Int32Array(N * N);
        let rootPlayer = W;

        function rand64() {
            // 可复现的 xorshift64 生成器
            rand64.seed ^= rand64.seed << 13n;
            rand64.seed ^= rand64.seed >> 7n;
            rand64.seed ^= rand64.seed << 17n;
            return rand64.seed & ((1n << 64n) - 1n);
        }
        rand64.seed = 0x9e3779b97f4a7c15n;

        function initZobrist() {
            zobrist = Array.from({ length: N * N }, () => [0n, rand64(), rand64()]);
            hash = 0n;
            for (let i = 0; i < board.length; i++) if (board[i]) hash ^= zobrist[i][board[i]];
        }
        function checkTime() {
            if (cancelled || Date.now() >= deadline) throw new Error("STOP_SEARCH");
        }
        function put(i, p) {
            board[i] = p;
            hash ^= zobrist[i][p];
        }
        function take(i, p) {
            board[i] = E;
            hash ^= zobrist[i][p];
        }
        function winAt(i, p) {
            const x = i % N, y = (i / N) | 0;
            for (const [dx, dy] of DIRS) {
                let count = 1;
                for (const s of [-1, 1]) {
                    let xx = x + dx * s, yy = y + dy * s;
                    while (xx >= 0 && xx < N && yy >= 0 && yy < N && board[yy*N+xx] === p) {
                        count++; xx += dx*s; yy += dy*s;
                    }
                }
                if (count >= 5) return true;
            }
            return false;
        }
        function hasNeighbor(i, dist=2) {
            const x=i%N, y=(i/N)|0;
            for(let dy=-dist;dy<=dist;dy++) for(let dx=-dist;dx<=dist;dx++){
                if(!dx&&!dy) continue;
                const xx=x+dx, yy=y+dy;
                if(xx>=0&&xx<N&&yy>=0&&yy<N&&board[yy*N+xx]) return true;
            }
            return false;
        }
        function linePattern(i, p, dx, dy) {
            const x=i%N, y=(i/N)|0;
            let own=1, open=0, blocks=0;
            for(const s of [-1,1]){
                let xx=x+dx*s, yy=y+dy*s, steps=0;
                while(xx>=0&&xx<N&&yy>=0&&yy<N&&board[yy*N+xx]===p&&steps<5){
                    own++; steps++; xx+=dx*s; yy+=dy*s;
                }
                if(xx>=0&&xx<N&&yy>=0&&yy<N){
                    if(board[yy*N+xx]===E) open++;
                    else blocks++;
                } else blocks++;
            }
            return {own,open,blocks};
        }
        function pointScore(i,p) {
            let total=0;
            for(const [dx,dy] of DIRS){
                const q=linePattern(i,p,dx,dy);
                if(q.own>=5) total+=WIN;
                else if(q.own===4&&q.open===2) total+=2e8;
                else if(q.own===4&&q.open===1) total+=2e7;
                else if(q.own===3&&q.open===2) total+=2e6;
                else if(q.own===3&&q.open===1) total+=2e5;
                else if(q.own===2&&q.open===2) total+=2e4;
                else if(q.own===2&&q.open===1) total+=2e3;
                else if(q.own===1&&q.open===2) total+=100;
            }
            // 中心偏好只作为极轻微的平局打破项
            const cx=(i%N)-7, cy=((i/N)|0)-7;
            total += Math.max(0, 14-Math.abs(cx)-Math.abs(cy));
            return total;
        }
        function immediateWinningMoves(p, candidates) {
            const wins=[];
            for(const i of candidates){
                put(i,p);
                const won=winAt(i,p);
                take(i,p);
                if(won) wins.push(i);
            }
            return wins;
        }
        function generate(p, limit=12) {
            const cand=[];
            let occupied=0;
            for(let i=0;i<board.length;i++) if(board[i]) occupied++;
            if(!occupied) return [112];
            for(let i=0;i<board.length;i++){
                if(board[i]!==E||!hasNeighbor(i,2)) continue;
                const own=pointScore(i,p), opp=pointScore(i,p===B?W:B);
                // 防守权重略高，避免忽略对方的紧急威胁
                const score=own+opp*1.12+history[i];
                cand.push({i,score});
            }
            cand.sort((a,b)=>b.score-a.score);
            return cand.slice(0,limit).map(v=>v.i);
        }
        function evaluate(p) {
            let own=0, opp=0;
            for(let i=0;i<board.length;i++){
                if(board[i]===p) own += pointScore(i,p)*0.12;
                else if(board[i]=== (p===B?W:B)) opp += pointScore(i,p===B?W:B)*0.12;
            }
            return own-opp;
        }
        function tacticalCandidates(p) {
            const base=generate(p,18);
            const wins=immediateWinningMoves(p,base);
            if(wins.length) return wins;
            const enemy=p===B?W:B;
            const blocks=immediateWinningMoves(enemy,base);
            if(blocks.length) return blocks;
            return base;
        }
        function ttKey() { return hash.toString(); }
        function search(depth, alpha, beta, p, ply) {
            if((++nodes & 1023)===0) checkTime();
            const key=ttKey(), entry=table.get(key);
            const originalAlpha=alpha, originalBeta=beta;
            if(entry&&entry.depth>=depth){
                if(entry.flag===0) return entry.score;
                if(entry.flag===1) alpha=Math.max(alpha,entry.score);
                else beta=Math.min(beta,entry.score);
                if(alpha>=beta) return entry.score;
            }
            if(depth===0) return evaluate(p);
            let moves=tacticalCandidates(p);
            if(!moves.length) return evaluate(p);
            if(entry&&entry.best!==undefined){
                const at=moves.indexOf(entry.best);
                if(at>0) moves.unshift(moves.splice(at,1)[0]);
            }
            let best=-INF, bestMove=moves[0];
            for(const i of moves){
                put(i,p);
                let score;
                if(winAt(i,p)) score=WIN-ply;
                else score=-search(depth-1,-beta,-alpha,p===B?W:B,ply+1);
                take(i,p);
                if(score>best){best=score;bestMove=i;}
                if(score>alpha) alpha=score;
                if(alpha>=beta){
                    history[i]+=depth*depth;
                    killer[ply]=i;
                    break;
                }
            }
            const flag=best<=originalAlpha?2:(best>=originalBeta?1:0);
            if(table.size>120000) table.clear();
            table.set(key,{depth,score:best,flag,best:bestMove});
            return best;
        }
        function rootSearch(depth) {
            let moves=tacticalCandidates(rootPlayer);
            if(!moves.length) return {move:-1,score:0};
            const opp=rootPlayer===B?W:B;
            const oppMoves=generate(opp,20);
            const wins=immediateWinningMoves(rootPlayer,moves);
            if(wins.length) return {move:wins[0],score:WIN};
            const blocks=immediateWinningMoves(opp,oppMoves);
            if(blocks.length) {
                // 若对方有一手胜点，优先封堵
                moves=blocks;
            }
            let best=-INF,bestMove=moves[0],alpha=-INF,beta=INF;
            const tt=table.get(ttKey());
            if(tt&&moves.includes(tt.best)) moves=[tt.best,...moves.filter(x=>x!==tt.best)];
            for(const i of moves){
                checkTime();
                put(i,rootPlayer);
                const score=winAt(i,rootPlayer)?WIN:
                    -search(depth-1,-beta,-alpha,opp,1);
                take(i,rootPlayer);
                if(score>best){best=score;bestMove=i;}
                if(score>alpha) alpha=score;
            }
            return {move:bestMove,score:best};
        }
        function doSearch(msg) {
            cancelled=false; activeId=msg.id; nodes=0;
            board=new Int8Array(msg.board);
            rootPlayer=msg.player||W;
            deadline=Date.now()+Math.max(250,msg.maxTime||1800);
            maxDepth=Math.max(1,Math.min(9,msg.maxDepth||6));
            table=new Map(); killer=[]; history=new Int32Array(N*N);
            initZobrist();
            let best=board.every(v=>v===0)?112:board.findIndex(v=>v===0);
            let completedDepth=0;
            try {
                // 先保证有合法候选，避免超时前没有任何可返回结果
                const first=tacticalCandidates(rootPlayer);
                if(first.length) best=first[0];
                for(let depth=1;depth<=maxDepth;depth++){
                    checkTime();
                    const result=rootSearch(depth);
                    if(result.move>=0) best=result.move;
                    completedDepth=depth;
                    postMessage({type:"progress",id:activeId,depth,nodes});
                    if(Math.abs(result.score)>=WIN/2) break;
                }
            } catch(err) {
                if(err.message!=="STOP_SEARCH") throw err;
            }
            postMessage({type:"result",id:activeId,move:best,depth:completedDepth,nodes});
        }
        self.onmessage = event => {
            const msg=event.data||{};
            if(msg.type==="cancel"){cancelled=true;return;}
            if(msg.type==="search"){
                try { doSearch(msg); }
                catch(err) {
                    postMessage({type:"result",id:msg.id,move:board.findIndex(v=>v===E),error:String(err)});
                }
            }
        };
    }

    // 非 Worker 环境的安全兜底：先找立即胜点，再找必防点，再找邻近空位。
    function simpleFallback(snapshot, player) {
        const b = snapshot.slice();
        const other = player === BLACK ? WHITE : BLACK;
        function winsFor(p) {
            for (let i = 0; i < b.length; i++) {
                if (b[i] !== EMPTY) continue;
                b[i] = p;
                const x = i % SIZE, y = Math.floor(i / SIZE);
                let won = false;
                for (const [dx, dy] of DIRECTIONS) {
                    let count = 1;
                    for (const sign of [-1, 1]) {
                        let xx=x+dx*sign, yy=y+dy*sign;
                        while (inBounds(xx,yy) && b[indexOf(xx,yy)]===p) {
                            count++; xx+=dx*sign; yy+=dy*sign;
                        }
                    }
                    if (count >= 5) won = true;
                }
                b[i] = EMPTY;
                if (won) return i;
            }
            return -1;
        }
        let move = winsFor(player);
        if (move < 0) move = winsFor(other);
        if (move >= 0) return move;
        for (let i=0;i<b.length;i++) {
            if (b[i]!==EMPTY) continue;
            const x=i%SIZE,y=Math.floor(i/SIZE);
            for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++){
                if(!dx&&!dy) continue;
                const xx=x+dx,yy=y+dy;
                if(inBounds(xx,yy)&&b[indexOf(xx,yy)]!==EMPTY) return i;
            }
        }
        return b.findIndex(v=>v===EMPTY);
    }

    createBoard();
    resetGame();

    window.addEventListener("beforeunload", () => {
        if (worker) worker.terminate();
        if (workerURL) URL.revokeObjectURL(workerURL);
    });
})();