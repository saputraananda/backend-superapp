// Helper round Rupiah 2 decimal
export function toFixed2(val) {
    const num = Number(val) || 0;
    return Math.round(num * 100) / 100;
}

// Helper format Rupiah untuk error message
export function formatRupiah(num) {
    return new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency: "IDR",
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    }).format(num);
}