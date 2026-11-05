/**
 * Loads pdfmake's server classes. In the compiled build, import() of these CommonJS files puts their
 * exports under an extra "default" key, while tsx does not, so the wrapper has to be removed here.
 */
const unwrap = (loaded: any) => loaded?.default?.default ?? loaded?.default ?? loaded;

export async function loadPdfMake(): Promise<{ PdfPrinter: any; virtualFs: any; URLResolver: any }> {
    const [PdfPrinter, virtualFs, URLResolver] = await Promise.all([
        import("pdfmake/js/Printer.js" as any),
        import("pdfmake/js/virtual-fs.js" as any),
        import("pdfmake/js/URLResolver.js" as any),
    ]);
    return { PdfPrinter: unwrap(PdfPrinter), virtualFs: unwrap(virtualFs), URLResolver: unwrap(URLResolver) };
}
