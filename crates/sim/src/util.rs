//! Flat f32 state serialisation shared by snapshots, prediction and the JS layout table.
use crate::math::V3;

pub struct Rd<'a> {
    d: &'a [f32],
    i: usize,
}
impl<'a> Rd<'a> {
    pub fn new(d: &'a [f32]) -> Self {
        Rd { d, i: 0 }
    }
    pub fn f(&mut self) -> f32 {
        let v = self.d.get(self.i).copied().unwrap_or(0.0);
        self.i += 1;
        v
    }
}

/// A value that packs into consecutive f32s. `layout` emits "name:offset," pairs so the
/// TypeScript side reads fields by name instead of duplicating offsets.
pub trait Field: Sized {
    fn put(&self, o: &mut Vec<f32>);
    fn get(&mut self, r: &mut Rd);
    fn layout(name: &str, off: &mut usize, out: &mut String);
}

fn leaf(name: &str, off: &mut usize, out: &mut String, n: usize) {
    out.push_str(name);
    out.push(':');
    out.push_str(&off.to_string());
    out.push(',');
    *off += n;
}

impl Field for f32 {
    fn put(&self, o: &mut Vec<f32>) {
        o.push(*self);
    }
    fn get(&mut self, r: &mut Rd) {
        *self = r.f();
    }
    fn layout(name: &str, off: &mut usize, out: &mut String) {
        leaf(name, off, out, 1);
    }
}
impl Field for bool {
    fn put(&self, o: &mut Vec<f32>) {
        o.push(if *self { 1.0 } else { 0.0 });
    }
    fn get(&mut self, r: &mut Rd) {
        *self = r.f() > 0.5;
    }
    fn layout(name: &str, off: &mut usize, out: &mut String) {
        leaf(name, off, out, 1);
    }
}
macro_rules! int_field {
    ($($t:ty),*) => {$(
        impl Field for $t {
            fn put(&self, o: &mut Vec<f32>) { o.push(*self as f32); }
            fn get(&mut self, r: &mut Rd) { *self = r.f() as $t; }
            fn layout(name: &str, off: &mut usize, out: &mut String) { leaf(name, off, out, 1); }
        }
    )*};
}
int_field!(u8, i32, u32);

impl Field for V3 {
    fn put(&self, o: &mut Vec<f32>) {
        o.extend_from_slice(&[self.x, self.y, self.z]);
    }
    fn get(&mut self, r: &mut Rd) {
        *self = V3 { x: r.f(), y: r.f(), z: r.f() };
    }
    fn layout(name: &str, off: &mut usize, out: &mut String) {
        leaf(name, off, out, 3);
    }
}
impl<T: Field, const N: usize> Field for [T; N] {
    fn put(&self, o: &mut Vec<f32>) {
        for v in self {
            v.put(o);
        }
    }
    fn get(&mut self, r: &mut Rd) {
        for v in self {
            v.get(r);
        }
    }
    fn layout(name: &str, off: &mut usize, out: &mut String) {
        for i in 0..N {
            T::layout(&format!("{name}{i}"), off, out);
        }
    }
}

/// Declares a plain-data struct together with its `Field` impl.
#[macro_export]
macro_rules! state {
    ($(#[$m:meta])* pub struct $n:ident { $($(#[$fm:meta])* pub $f:ident : $t:ty),* $(,)? }) => {
        $(#[$m])*
        #[derive(Clone, Copy, Debug, Default)]
        pub struct $n { $($(#[$fm])* pub $f: $t),* }
        impl $crate::util::Field for $n {
            fn put(&self, o: &mut Vec<f32>) { $( $crate::util::Field::put(&self.$f, o); )* }
            fn get(&mut self, r: &mut $crate::util::Rd) { $( $crate::util::Field::get(&mut self.$f, r); )* }
            fn layout(name: &str, off: &mut usize, out: &mut String) {
                let p = if name.is_empty() { String::new() } else { format!("{name}.") };
                $( <$t as $crate::util::Field>::layout(&format!("{p}{}", stringify!($f)), off, out); )*
            }
        }
    };
}

/// xorshift32. Deterministic so host and predicting client agree on spread.
#[derive(Clone, Copy, Debug)]
pub struct Rng(pub u32);
impl Rng {
    pub fn new(seed: u32) -> Rng {
        let mut r = Rng(seed ^ 0x9E37_79B9);
        if r.0 == 0 {
            r.0 = 0x1234_5678;
        }
        r.next();
        r
    }
    pub fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    /// Uniform in [0, 1).
    pub fn f(&mut self) -> f32 {
        (self.next() >> 8) as f32 / 16_777_216.0
    }
    pub fn range(&mut self, n: usize) -> usize {
        if n == 0 { 0 } else { (self.next() as usize) % n }
    }
    pub fn chance(&mut self, p: f32) -> bool {
        self.f() < p
    }
}
