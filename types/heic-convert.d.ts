declare module 'heic-convert' {
  interface ConvertOptions {
    buffer: Buffer | ArrayBuffer | Uint8Array;
    format: 'JPEG' | 'PNG';
    quality?: number;
  }

  function convert(options: ConvertOptions): Promise<ArrayBuffer>;

  namespace convert {
    function all(options: ConvertOptions): Promise<
      Array<{ convert: () => Promise<ArrayBuffer> }>
    >;
  }

  export default convert;
}
