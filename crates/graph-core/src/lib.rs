use std::collections::HashSet;
use std::f64::consts::TAU;
use wasm_bindgen::prelude::*;

const NONE: u32 = u32::MAX;
const UNREACHABLE: u8 = 255;

#[wasm_bindgen]
pub struct Graph {
    names: String,
    // Start of each name; name_off[N] = names.len() + 1 as if a trailing '\n' existed.
    name_off: Vec<u32>,
    depth: Vec<u8>,
    flags: Vec<u8>,
    path_count: Vec<u32>,
    edge_from: Vec<u32>,
    edge_to: Vec<u32>,
    // CSR adjacency holding edge indices.
    out_off: Vec<u32>,
    out_edges: Vec<u32>,
    in_off: Vec<u32>,
    in_edges: Vec<u32>,
}

fn pad4(n: usize) -> usize {
    (n + 3) & !3
}

pub fn encode(
    names: &[impl AsRef<str>],
    depth: &[u8],
    flags: &[u8],
    path_count: &[u32],
    edge_from: &[u32],
    edge_to: &[u32],
) -> Vec<u8> {
    let joined = names.iter().map(|s| s.as_ref()).collect::<Vec<_>>().join("\n");
    let mut out = Vec::new();
    out.extend_from_slice(b"DMAP");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    for v in [names.len(), edge_from.len(), joined.len()] {
        out.extend_from_slice(&(v as u32).to_le_bytes());
    }
    out.extend_from_slice(depth);
    out.extend_from_slice(flags);
    out.resize(pad4(out.len()), 0);
    for v in path_count.iter().chain(edge_from).chain(edge_to) {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(joined.as_bytes());
    out
}

fn csr(n: usize, keys: &[u32]) -> (Vec<u32>, Vec<u32>) {
    let mut off = vec![0u32; n + 1];
    for &k in keys {
        off[k as usize + 1] += 1;
    }
    for i in 0..n {
        off[i + 1] += off[i];
    }
    let mut fill = off.clone();
    let mut items = vec![0u32; keys.len()];
    for (e, &k) in keys.iter().enumerate() {
        items[fill[k as usize] as usize] = e as u32;
        fill[k as usize] += 1;
    }
    (off, items)
}

fn package_name(pv: &[u8]) -> &[u8] {
    match pv.iter().rposition(|&b| b == b'@') {
        Some(i) if i > 0 => &pv[..i],
        _ => pv,
    }
}

impl Graph {
    pub fn decode(b: &[u8]) -> Result<Graph, String> {
        if b.len() < 20 || &b[..4] != b"DMAP" {
            return Err("bad magic".into());
        }
        let u16_at = |o: usize| u16::from_le_bytes([b[o], b[o + 1]]);
        let u32_at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap()) as usize;
        if u16_at(4) != 1 {
            return Err(format!("unsupported version {}", u16_at(4)));
        }
        let (n, e, names_len) = (u32_at(8), u32_at(12), u32_at(16));
        if n.max(e).max(names_len) > b.len() {
            return Err("length mismatch".into());
        }
        let arrays = pad4(20 + 2 * n);
        let names_at = arrays + 4 * (n + 2 * e);
        if b.len() != names_at + names_len {
            return Err("length mismatch".into());
        }
        let u32s = |o: usize, len: usize| (0..len).map(|i| u32_at(o + 4 * i) as u32).collect::<Vec<_>>();
        let edge_from = u32s(arrays + 4 * n, e);
        let edge_to = u32s(arrays + 4 * (n + e), e);
        if edge_from.iter().chain(&edge_to).any(|&v| v as usize >= n) {
            return Err("edge index out of range".into());
        }
        let names = std::str::from_utf8(&b[names_at..]).map_err(|_| "names are not UTF-8")?.to_string();
        let mut name_off = vec![0u32];
        name_off.extend(names.match_indices('\n').map(|(i, _)| i as u32 + 1));
        name_off.push(names.len() as u32 + 1);
        if name_off.len() != n + 1 {
            return Err("name count mismatch".into());
        }
        let (out_off, out_edges) = csr(n, &edge_from);
        let (in_off, in_edges) = csr(n, &edge_to);
        Ok(Graph {
            names,
            name_off,
            depth: b[20..20 + n].to_vec(),
            flags: b[20 + n..20 + 2 * n].to_vec(),
            path_count: u32s(arrays, n),
            edge_from,
            edge_to,
            out_off,
            out_edges,
            in_off,
            in_edges,
        })
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let names: Vec<&str> = (0..self.n()).map(|i| self.name_str(i)).collect();
        encode(&names, &self.depth, &self.flags, &self.path_count, &self.edge_from, &self.edge_to)
    }

    fn n(&self) -> usize {
        self.depth.len()
    }

    fn name_str(&self, i: usize) -> &str {
        &self.names[self.name_off[i] as usize..self.name_off[i + 1] as usize - 1]
    }

    fn nm(&self, i: u32) -> &[u8] {
        self.name_str(i as usize).as_bytes()
    }

    fn incoming(&self, v: usize) -> &[u32] {
        &self.in_edges[self.in_off[v] as usize..self.in_off[v + 1] as usize]
    }

    fn outgoing(&self, v: usize) -> &[u32] {
        &self.out_edges[self.out_off[v] as usize..self.out_off[v + 1] as usize]
    }

    fn by_name(&self, a: u32, b: u32) -> std::cmp::Ordering {
        self.nm(a).cmp(self.nm(b)).then(a.cmp(&b))
    }
}

#[wasm_bindgen]
impl Graph {
    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(bytes: &[u8]) -> Result<Graph, JsError> {
        Graph::decode(bytes).map_err(|e| JsError::new(&e))
    }

    #[wasm_bindgen(js_name = nodeCount)]
    pub fn node_count(&self) -> u32 {
        self.n() as u32
    }

    #[wasm_bindgen(js_name = edgeCount)]
    pub fn edge_count(&self) -> u32 {
        self.edge_from.len() as u32
    }

    pub fn name(&self, i: u32) -> String {
        self.name_str(i as usize).to_string()
    }

    pub fn depth(&self, i: u32) -> u8 {
        self.depth[i as usize]
    }

    pub fn flags(&self) -> Vec<u8> {
        self.flags.clone()
    }

    #[wasm_bindgen(js_name = pathCounts)]
    pub fn path_counts(&self) -> Vec<u32> {
        self.path_count.clone()
    }

    #[wasm_bindgen(js_name = edgeFrom)]
    pub fn edge_from(&self) -> Vec<u32> {
        self.edge_from.clone()
    }

    #[wasm_bindgen(js_name = edgeTo)]
    pub fn edge_to(&self) -> Vec<u32> {
        self.edge_to.clone()
    }

    #[wasm_bindgen(js_name = primaryParents)]
    pub fn primary_parents(&self) -> Vec<u32> {
        let d = &self.depth;
        (0..self.n())
            .map(|c| {
                if c == 0 || d[c] == UNREACHABLE {
                    return NONE;
                }
                // depth[p] < depth[c] keeps the result a tree even if the stored depths are inconsistent.
                self.incoming(c)
                    .iter()
                    .map(|&e| self.edge_from[e as usize])
                    .filter(|&p| d[p as usize] < d[c])
                    .min_by(|&a, &b| d[a as usize].cmp(&d[b as usize]).then(self.by_name(a, b)))
                    .unwrap_or(NONE)
            })
            .collect()
    }

    pub fn layout(&self, radius: f32) -> Vec<f32> {
        let (mid, jitter, outer) = self.fan(0.0);
        let gap = radius as f64 / self.max_depth() as f64;
        let mut out = vec![0f32; 2 * self.n()];
        for v in 1..self.n() {
            let theta = mid[v] * TAU;
            let r = self.depth[v] as f64 * gap + jitter[v] as f64 * 0.18 * gap;
            out[2 * v] = (r * theta.cos()) as f32;
            out[2 * v + 1] = (r * theta.sin()) as f32;
        }
        let r = radius as f64 * 1.08;
        for (k, &v) in outer.iter().enumerate() {
            let theta = TAU * k as f64 / outer.len() as f64;
            out[2 * v as usize] = (r * theta.cos()) as f32;
            out[2 * v as usize + 1] = (r * theta.sin()) as f32;
        }
        out
    }

    /// The same order as `layout`, drawn as an inverted tree: the root on top, one row per depth going down (y < 0).
    #[wasm_bindgen(js_name = layoutTree)]
    pub fn layout_tree(&self, width: f32, level: f32) -> Vec<f32> {
        // small subtrees get a minimum share, so a direct dependency with no children still has room for its label
        let (mid, jitter, outer) = self.fan(4.0);
        let (w, h) = (width as f64, level as f64);
        let mut out = vec![0f32; 2 * self.n()];
        for v in 1..self.n() {
            out[2 * v] = ((mid[v] - 0.5) * w) as f32;
            out[2 * v + 1] = (-(self.depth[v] as f64 + jitter[v] as f64 * 0.22) * h) as f32;
        }
        let y = -(self.max_depth() as f64 + 1.0) * h;
        for (k, &v) in outer.iter().enumerate() {
            out[2 * v as usize] = (((k as f64 + 0.5) / outer.len() as f64 - 0.5) * w) as f32;
            out[2 * v as usize + 1] = y as f32;
        }
        out
    }

    fn max_depth(&self) -> u8 {
        self.depth.iter().filter(|&&d| d != UNREACHABLE).max().copied().unwrap_or(0).max(1)
    }

    /// Each tree node's slot as a fraction of the full turn (a subtree's span is proportional to its size + `pad`),
    /// a small per-sibling depth jitter, and the nodes the tree doesn't reach.
    fn fan(&self, pad: f64) -> (Vec<f64>, Vec<i8>, Vec<u32>) {
        let n = self.n();
        let pp = self.primary_parents();
        let parents: Vec<u32> = pp.iter().copied().filter(|&p| p != NONE).collect();
        let (coff, _) = csr(n, &parents);
        let mut kids = vec![0u32; parents.len()];
        let mut fill = coff.clone();
        for (c, &p) in pp.iter().enumerate().filter(|&(_, &p)| p != NONE) {
            kids[fill[p as usize] as usize] = c as u32;
            fill[p as usize] += 1;
        }
        for v in 0..n {
            kids[coff[v] as usize..coff[v + 1] as usize].sort_unstable_by(|&a, &b| self.by_name(a, b));
        }
        let children = |v: usize| &kids[coff[v] as usize..coff[v + 1] as usize];

        // BFS order over the tree: parents always come before children.
        let mut order = Vec::with_capacity(n);
        order.push(0u32);
        let mut i = 0;
        while i < order.len() {
            order.extend_from_slice(children(order[i] as usize));
            i += 1;
        }
        let mut size = vec![1u32; n];
        for &v in order[1..].iter().rev() {
            size[pp[v as usize] as usize] += size[v as usize];
        }

        let mut start = vec![0f64; n];
        let mut span = vec![0f64; n];
        span[0] = 1.0;
        let mut mid = vec![0.5f64; n];
        let mut jitter = vec![0i8; n];
        let mut in_tree = vec![false; n];
        for &v in &order {
            let v = v as usize;
            in_tree[v] = true;
            let kids = children(v);
            let unit = span[v] / ((size[v] - 1) as f64 + pad * kids.len() as f64).max(1.0);
            let mut a = start[v];
            for (k, &c) in kids.iter().enumerate() {
                let c = c as usize;
                start[c] = a;
                span[c] = unit * (size[c] as f64 + pad);
                a += span[c];
                mid[c] = start[c] + span[c] / 2.0;
                jitter[c] = (k % 3) as i8 - 1;
            }
        }
        let mut outer: Vec<u32> = (0..n as u32).filter(|&v| !in_tree[v as usize]).collect();
        outer.sort_unstable_by(|&a, &b| self.by_name(a, b));
        (mid, jitter, outer)
    }

    #[wasm_bindgen(js_name = pathsToRoot)]
    pub fn paths_to_root(&self, node: u32) -> Vec<u32> {
        // Edge p->c lies on a root->node path iff c reaches node and the root reaches p.
        let mut seen = vec![false; self.n()];
        let mut queue = vec![node];
        seen[node as usize] = true;
        let mut edges = Vec::new();
        let mut i = 0;
        while i < queue.len() {
            for &e in self.incoming(queue[i] as usize) {
                let p = self.edge_from[e as usize] as usize;
                if self.depth[p] == UNREACHABLE {
                    continue;
                }
                edges.push(e);
                if !seen[p] {
                    seen[p] = true;
                    queue.push(p as u32);
                }
            }
            i += 1;
        }
        edges.sort_unstable();
        edges
    }

    pub fn descendants(&self, node: u32) -> Vec<u32> {
        let mut seen = vec![false; self.n()];
        let mut queue = vec![node];
        seen[node as usize] = true;
        let mut i = 0;
        while i < queue.len() {
            for &e in self.outgoing(queue[i] as usize) {
                let c = self.edge_to[e as usize];
                if !seen[c as usize] {
                    seen[c as usize] = true;
                    queue.push(c);
                }
            }
            i += 1;
        }
        queue.swap_remove(0);
        queue.sort_unstable();
        queue
    }

    pub fn search(&self, query: &str, limit: u32) -> Vec<u32> {
        let q = query.as_bytes();
        (0..self.n() as u32)
            .filter(|&i| {
                let name = self.nm(i);
                q.is_empty() || name.windows(q.len()).any(|w| w.eq_ignore_ascii_case(q))
            })
            .take(limit as usize)
            .collect()
    }
}

#[wasm_bindgen]
pub fn diff(a: &Graph, b: &Graph) -> Vec<u8> {
    let exact: HashSet<&[u8]> = (0..a.n() as u32).map(|i| a.nm(i)).collect();
    let pkgs: HashSet<&[u8]> = exact.iter().map(|pv| package_name(pv)).collect();
    (0..b.n() as u32)
        .map(|i| {
            let pv = b.nm(i);
            if exact.contains(pv) {
                0
            } else if pkgs.contains(package_name(pv)) {
                2
            } else {
                1
            }
        })
        .collect()
}

#[wasm_bindgen]
pub fn removed(a: &Graph, b: &Graph) -> Vec<u32> {
    let pkgs: HashSet<&[u8]> = (0..b.n() as u32).map(|i| package_name(b.nm(i))).collect();
    (0..a.n() as u32).filter(|&i| !pkgs.contains(package_name(a.nm(i)))).collect()
}

#[cfg(test)]
mod tests;
