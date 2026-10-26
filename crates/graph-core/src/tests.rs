use super::*;

struct Spec {
    names: Vec<String>,
    depth: Vec<u8>,
    from: Vec<u32>,
    to: Vec<u32>,
}

impl Spec {
    fn graph(&self) -> Graph {
        let n = self.names.len();
        let flags: Vec<u8> = (0..n).map(|i| if i == 0 { 128 } else { 0 }).collect();
        Graph::decode(&encode(&self.names, &self.depth, &flags, &vec![1; n], &self.from, &self.to)).unwrap()
    }
}

fn bfs_depth(n: usize, from: &[u32], to: &[u32]) -> Vec<u8> {
    let mut depth = vec![UNREACHABLE; n];
    depth[0] = 0;
    let mut changed = true;
    while changed {
        changed = false;
        for (&p, &c) in from.iter().zip(to) {
            let d = depth[p as usize].saturating_add(1);
            if depth[p as usize] != UNREACHABLE && d < depth[c as usize] {
                depth[c as usize] = d;
                changed = true;
            }
        }
    }
    depth
}

fn synth(n: usize, direct: usize, edges: usize, seed: u64) -> Spec {
    let mut s = seed;
    let mut rnd = |m: usize| {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        (s % m as u64) as usize
    };
    let (mut from, mut to) = (vec![], vec![]);
    for c in 1..n {
        from.push(if c <= direct { 0 } else { 1 + rnd(c - 1) } as u32);
        to.push(c as u32);
    }
    while from.len() < edges {
        let c = 2 + rnd(n - 2);
        from.push((1 + rnd(c - 1)) as u32);
        to.push(c as u32);
    }
    let names = (0..n).map(|i| format!("p{:x}@1.{}.0", (i as u64).wrapping_mul(0x9E3779B97F4A7C15) >> 32, i % 4)).collect();
    Spec { names, depth: bfs_depth(n, &from, &to), from, to }
}

fn diamond() -> Spec {
    Spec {
        names: ["app@1.0.0", "a@1.0.0", "b@1.0.0", "d@1.0.0", "c@1.0.0"].map(String::from).to_vec(),
        depth: vec![0, 1, 1, 2, 2],
        from: vec![0, 0, 1, 2, 1],
        to: vec![1, 2, 3, 3, 4],
    }
}

fn angle(xy: &[f32], v: usize) -> f64 {
    (xy[2 * v + 1] as f64).atan2(xy[2 * v] as f64)
}

#[test]
fn codec_roundtrip() {
    let names = ["app@1.0.0", "@scope/pkg@1.0.0", "ms@2.1.2"];
    let bytes = encode(&names, &[0, 1, 2], &[128, 1, 2], &[1, 1, 7], &[0, 1], &[1, 2]);
    let g = Graph::decode(&bytes).unwrap();
    assert_eq!(g.to_bytes(), bytes);
    assert_eq!((g.node_count(), g.edge_count()), (3, 2));
    assert_eq!(g.name(1), "@scope/pkg@1.0.0");
    assert_eq!(g.depth(2), 2);
    assert_eq!(g.flags(), vec![128, 1, 2]);
    assert_eq!(g.path_counts(), vec![1, 1, 7]);
}

#[test]
fn js_encoder_matches() {
    let js = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/tiny.bin")).unwrap();
    let names = ["app@1.0.0", "@scope/pkg@1.0.0", "ms@2.1.2"];
    assert_eq!(encode(&names, &[0, 1, 2], &[128, 1, 2], &[1, 1, 7], &[0, 1], &[1, 2]), js);
}

#[test]
fn bad_input_is_error() {
    let mut bytes = diamond().graph().to_bytes();
    assert!(Graph::decode(&bytes[..bytes.len() - 1]).is_err());
    bytes[0] = b'X';
    assert_eq!(Graph::decode(&bytes).err().unwrap(), "bad magic");
}

#[test]
fn layout_is_deterministic() {
    let g = synth(2000, 30, 5000, 7).graph();
    let bits = |v: Vec<f32>| v.into_iter().map(f32::to_bits).collect::<Vec<_>>();
    assert_eq!(bits(g.layout(1000.0)), bits(g.layout(1000.0)));
}

#[test]
fn layout_radii() {
    let mut spec = synth(1000, 20, 2400, 3);
    spec.names.push("orphan@1.0.0".into());
    spec.depth.push(UNREACHABLE);
    let g = spec.graph();
    let xy = g.layout(500.0);
    assert_eq!((xy[0], xy[1]), (0.0, 0.0));
    let max_depth = *spec.depth.iter().filter(|&&d| d != UNREACHABLE).max().unwrap() as f64;
    let gap = 500.0 / max_depth;
    for v in 1..g.n() {
        let r = (xy[2 * v] as f64).hypot(xy[2 * v + 1] as f64);
        let want = if spec.depth[v] == UNREACHABLE { 540.0 } else { spec.depth[v] as f64 * gap };
        assert!((r - want).abs() <= 0.18 * gap + 1e-3, "node {v}: r={r} want={want}");
    }
}

#[test]
fn layout_is_stable() {
    let base = synth(300, 12, 700, 11);
    let mut grown = synth(300, 12, 700, 11);
    let wedge_root = 3u32;
    grown.names.push("zz-new@1.0.0".into());
    grown.depth.push(2);
    grown.from.push(wedge_root);
    grown.to.push(300);
    let (a, b) = (base.graph(), grown.graph());
    let pp = a.primary_parents();
    let (xa, xb) = (a.layout(1000.0), b.layout(1000.0));
    let wedge = |mut v: u32| {
        while pp[v as usize] != 0 {
            v = pp[v as usize];
        }
        v
    };
    for v in 1..300 {
        if wedge(v) == wedge_root {
            continue;
        }
        let d = (angle(&xa, v as usize) - angle(&xb, v as usize) + TAU * 1.5) % TAU - TAU / 2.0;
        assert!(d.abs().to_degrees() <= 2.0, "node {v} moved {}°", d.to_degrees());
    }
}

#[test]
fn primary_parent_ties_by_name() {
    let g = diamond().graph();
    assert_eq!(g.primary_parents(), vec![NONE, 0, 0, 1, 1]);
}

#[test]
fn paths_to_root_diamond() {
    let g = diamond().graph();
    assert_eq!(g.paths_to_root(3), vec![0, 1, 2, 3]);
    assert_eq!(g.paths_to_root(4), vec![0, 4]);
    assert_eq!(g.descendants(1), vec![3, 4]);
    assert_eq!(g.descendants(0), vec![1, 2, 3, 4]);
}

#[test]
fn diff_and_removed() {
    let mk = |names: &[&str]| {
        let n = names.len();
        let from: Vec<u32> = vec![0; n - 1];
        let to: Vec<u32> = (1..n as u32).collect();
        Spec { names: names.iter().map(|s| s.to_string()).collect(), depth: bfs_depth(n, &from, &to), from, to }.graph()
    };
    let a = mk(&["app@1.0.0", "chalk@4.1.2", "@scope/pkg@1.0.0", "left-pad@1.3.0", "@scope/gone@2.0.0"]);
    let b = mk(&["app@1.0.0", "chalk@5.3.0", "@scope/pkg@1.0.0", "@scope/new@1.0.0", "ms@2.1.2"]);
    assert_eq!(diff(&a, &b), vec![0, 2, 0, 1, 1]);
    assert_eq!(removed(&a, &b), vec![3, 4]);
    assert_eq!(package_name(b"@scope/pkg@1.0.0"), b"@scope/pkg");
    assert_eq!(package_name(b"@scope/pkg"), b"@scope/pkg");
}

#[test]
fn search_is_case_insensitive_and_capped() {
    let g = diamond().graph();
    assert_eq!(g.search("@1.0", 10), vec![0, 1, 2, 3, 4]);
    assert_eq!(g.search("@1.0", 2), vec![0, 1]);
    assert_eq!(g.search("APP", 10), vec![0]);
    assert!(g.search("nope", 10).is_empty());
}

#[test]
#[ignore]
fn perf_layout_50k() {
    let g = synth(50_000, 40, 120_000, 1).graph();
    let t = std::time::Instant::now();
    let xy = g.layout(1000.0);
    let ms = t.elapsed().as_secs_f64() * 1e3;
    println!("layout 50k nodes / 120k edges: {ms:.1} ms");
    assert_eq!(xy.len(), 100_000);
    assert!(ms < 500.0);
}

#[test]
fn tree_layout_hangs_down_from_the_root() {
    let mut spec = synth(1000, 20, 2400, 5);
    spec.names.push("orphan@1.0.0".into());
    spec.depth.push(UNREACHABLE);
    let g = spec.graph();
    let xy = g.layout_tree(2000.0, 100.0);
    let pp = g.primary_parents();
    assert_eq!((xy[0], xy[1]), (0.0, 0.0));
    for v in 1..g.n() {
        assert!(xy[2 * v].abs() <= 1000.0, "node {v} outside the width");
        if spec.depth[v] == UNREACHABLE {
            assert!(xy[2 * v + 1] < -(*spec.depth.iter().filter(|&&d| d != UNREACHABLE).max().unwrap() as f32) * 100.0);
        } else {
            assert!(xy[2 * v + 1] < xy[2 * pp[v] as usize + 1], "node {v} is not below its parent");
        }
    }
}
