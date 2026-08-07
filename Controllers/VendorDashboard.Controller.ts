import type { Request, Response } from "express";
import pool from "../DbConnect";

export const getVendorDashboardController = async (req: Request, res: Response): Promise<Response> => {
    const { userId, role } = (req as any).user;
    if (!userId) {
        return res.status(400).json({ message: "User ID is required!" });
    }

    if (role !== 'vendor') {
        return res.status(403).json({ message: "Unauthorized! Only vendors can access dashboard!" });
    }

    try {
        // Get vendor id from user_id
        const vendorResult = await pool.query('SELECT id, vendor_type FROM vendors WHERE user_id = $1', [userId]);
        if (vendorResult.rows.length === 0) {
            return res.status(404).json({ message: "Vendor not found. Please setup your profile first." });
        }
        const { id: vendorId, vendor_type: vendorType } = vendorResult.rows[0];
        const isService = vendorType === "service";

        // 1. Stats
        const statsQuery = isService ? `
            SELECT
                COALESCE(SUM(sb.total_amount), 0) AS total_revenue,
                COUNT(sb.id) AS total_orders,
                (SELECT COUNT(*) FROM vendor_services vs WHERE vs.vendor_id = $1 AND vs.is_active = true) AS active_products,
                COUNT(DISTINCT sb.user_id) AS total_customers
            FROM service_bookings sb
            WHERE sb.vendor_id = $1 AND sb.status != 'cancelled'
        ` : `
            SELECT
                COALESCE(SUM(o.total_amount), 0) AS total_revenue,
                COUNT(o.id) AS total_orders,
                (SELECT COUNT(*) FROM vendor_products vp WHERE vp.vendor_id = $1 AND vp.is_active = true) AS active_products,
                (SELECT COUNT(DISTINCT o2.user_id) FROM orders o2 WHERE o2.vendor_id = $1 AND NOT (o2.status = 'pending' AND o2.payment_status = 'pending' AND o2.source IN ('client', 'quotation'))) AS total_customers
            FROM orders o
            WHERE o.vendor_id = $1 AND NOT (o.status = 'pending' AND o.payment_status = 'pending' AND o.source IN ('client', 'quotation'))
        `;
        const statsResult = await pool.query(statsQuery, [vendorId]);
        const stats = statsResult.rows[0];

        // 2. Revenue chart - dynamic timeframe
        const timeframe = (req.query.timeframe as string) || '7';
        const chartLabels: string[] = [];
        const chartData: number[] = [];

        if (timeframe === '365') {
            // Group by month for this year
            const revenueChartQuery = isService ? `
                SELECT
                    TO_CHAR(sb.created_at, 'Mon') AS month_name,
                    EXTRACT(MONTH FROM sb.created_at)::integer AS month_num,
                    COALESCE(SUM(sb.total_amount), 0) AS revenue
                FROM service_bookings sb
                WHERE sb.vendor_id = $1
                    AND sb.status != 'cancelled'
                    AND sb.created_at >= DATE_TRUNC('year', NOW())
                GROUP BY TO_CHAR(sb.created_at, 'Mon'), EXTRACT(MONTH FROM sb.created_at)
                ORDER BY month_num ASC
            ` : `
                SELECT
                    TO_CHAR(o.created_at, 'Mon') AS month_name,
                    EXTRACT(MONTH FROM o.created_at)::integer AS month_num,
                    COALESCE(SUM(o.total_amount), 0) AS revenue
                FROM orders o
                WHERE o.vendor_id = $1
                    AND NOT (o.status = 'pending' AND o.payment_status = 'pending' AND o.source IN ('client', 'quotation'))
                    AND o.created_at >= DATE_TRUNC('year', NOW())
                GROUP BY TO_CHAR(o.created_at, 'Mon'), EXTRACT(MONTH FROM o.created_at)
                ORDER BY month_num ASC
            `;
            const revenueChartResult = await pool.query(revenueChartQuery, [vendorId]);
            
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const revenueMap = new Map<string, number>();

            for (const row of revenueChartResult.rows) {
                revenueMap.set(row.month_name, parseFloat(row.revenue));
            }

            for (let i = 0; i < 12; i++) {
                chartLabels.push(monthNames[i]);
                chartData.push(revenueMap.get(monthNames[i]) || 0);
            }
        } else {
            // last 7 or 30 days
            const intervalDays = timeframe === '30' ? 29 : 6;
            const revenueChartQuery = isService ? `
                SELECT
                    DATE(sb.created_at)::text AS day_date,
                    COALESCE(SUM(sb.total_amount), 0) AS revenue
                FROM service_bookings sb
                WHERE sb.vendor_id = $1
                    AND sb.status != 'cancelled'
                    AND sb.created_at >= NOW() - ($2 * INTERVAL '1 day')
                GROUP BY DATE(sb.created_at)
                ORDER BY DATE(sb.created_at) ASC
            ` : `
                SELECT
                    DATE(o.created_at)::text AS day_date,
                    COALESCE(SUM(o.total_amount), 0) AS revenue
                FROM orders o
                WHERE o.vendor_id = $1
                    AND NOT (o.status = 'pending' AND o.payment_status = 'pending' AND o.source IN ('client', 'quotation'))
                    AND o.created_at >= NOW() - ($2 * INTERVAL '1 day')
                GROUP BY DATE(o.created_at)
                ORDER BY DATE(o.created_at) ASC
            `;
            const revenueChartResult = await pool.query(revenueChartQuery, [vendorId, intervalDays]);

            const revenueMap = new Map<string, number>();
            for (const row of revenueChartResult.rows) {
                revenueMap.set(row.day_date, parseFloat(row.revenue));
            }

            for (let i = intervalDays; i >= 0; i--) {
                const date = new Date();
                date.setDate(date.getDate() - i);
                const dateStr = date.toISOString().split('T')[0];
                
                if (timeframe === '30') {
                    const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    chartLabels.push(label);
                } else {
                    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                    const dayName = dayNames[date.getDay()];
                    chartLabels.push(dayName);
                }
                chartData.push(revenueMap.get(dateStr) || 0);
            }
        }

        // 3. Recent orders (last 5)
        const recentOrdersQuery = isService ? `
            SELECT
                sb.id AS order_id,
                sb.status,
                sb.total_amount,
                sb.created_at,
                u.name AS customer_name,
                s.name AS product_name
            FROM service_bookings sb
            JOIN users u ON sb.user_id = u.id
            JOIN vendor_services vs ON sb.vendor_service_id = vs.id
            JOIN services s ON vs.service_id = s.id
            WHERE sb.vendor_id = $1
            ORDER BY sb.created_at DESC
            LIMIT 5
        ` : `
            SELECT
                o.id AS order_id,
                o.status,
                o.total_amount,
                o.created_at,
                u.name AS customer_name,
                (
                    SELECT p.name
                    FROM order_items oi
                    JOIN products p ON oi.product_id = p.id
                    WHERE oi.order_id = o.id
                    LIMIT 1
                ) AS product_name
            FROM orders o
            JOIN users u ON o.user_id = u.id
            WHERE o.vendor_id = $1 AND NOT (o.status = 'pending' AND o.payment_status = 'pending' AND o.source IN ('client', 'quotation'))
            ORDER BY o.created_at DESC
            LIMIT 5
        `;
        const recentOrdersResult = await pool.query(recentOrdersQuery, [vendorId]);

        // 4. Top products (by total quantity sold)
        const topProductsQuery = isService ? `
            SELECT
                s.name AS product_name,
                COUNT(sb.id) AS total_sales,
                SUM(sb.total_amount) AS total_revenue
            FROM service_bookings sb
            JOIN vendor_services vs ON sb.vendor_service_id = vs.id
            JOIN services s ON vs.service_id = s.id
            WHERE sb.vendor_id = $1 AND sb.status != 'cancelled'
            GROUP BY s.name
            ORDER BY total_sales DESC
            LIMIT 3
        ` : `
            SELECT
                p.name AS product_name,
                SUM(oi.quantity) AS total_sales,
                SUM(oi.quantity * oi.price) AS total_revenue
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            JOIN products p ON oi.product_id = p.id
            WHERE oi.vendor_id = $1 AND NOT (o.status = 'pending' AND o.payment_status = 'pending' AND o.source IN ('client', 'quotation'))
            GROUP BY p.name
            ORDER BY total_sales DESC
            LIMIT 3
        `;
        const topProductsResult = await pool.query(topProductsQuery, [vendorId]);

        return res.status(200).json({
            message: "Dashboard data fetched successfully",
            data: {
                stats: {
                    totalRevenue: parseFloat(stats.total_revenue) || 0,
                    totalOrders: parseInt(stats.total_orders) || 0,
                    activeProducts: parseInt(stats.active_products) || 0,
                    totalCustomers: parseInt(stats.total_customers) || 0,
                },
                revenueChart: {
                    labels: chartLabels,
                    data: chartData,
                },
                recentOrders: recentOrdersResult.rows.map((row: any) => ({
                    orderId: row.order_id,
                    customerName: row.customer_name,
                    productName: row.product_name || 'N/A',
                    date: row.created_at,
                    amount: parseFloat(row.total_amount) || 0,
                    status: row.status,
                })),
                topProducts: topProductsResult.rows.map((row: any) => ({
                    name: row.product_name,
                    sales: parseInt(row.total_sales) || 0,
                    revenue: parseFloat(row.total_revenue) || 0,
                })),
            }
        });
    } catch (e) {
        console.error("Error fetching vendor dashboard:", e);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const getVendorAnalyticsController = async (req: Request, res: Response): Promise<Response> => {
    const { userId, role } = (req as any).user;
    if (!userId) {
        return res.status(400).json({ message: "User ID is required!" });
    }

    if (role !== 'vendor') {
        return res.status(403).json({ message: "Unauthorized! Only vendors can access analytics!" });
    }

    const timeframe = (req.query.timeframe as string) || 'year';

    try {
        const vendorResult = await pool.query('SELECT id, vendor_type FROM vendors WHERE user_id = $1', [userId]);
        if (vendorResult.rows.length === 0) {
            return res.status(404).json({ message: "Vendor not found. Please setup your profile first." });
        }
        const vendorId = vendorResult.rows[0].id;
        const isService = vendorResult.rows[0].vendor_type === 'service';

        let dateFilter = '';
        let previousDateFilter = '';
        
        if (timeframe === 'month') {
            dateFilter = isService ? `AND sb.created_at >= DATE_TRUNC('month', NOW())` : `AND o.created_at >= DATE_TRUNC('month', NOW())`;
            previousDateFilter = isService ? `AND sb.created_at >= DATE_TRUNC('month', NOW() - INTERVAL '1 month') AND sb.created_at < DATE_TRUNC('month', NOW())` : `AND o.created_at >= DATE_TRUNC('month', NOW() - INTERVAL '1 month') AND o.created_at < DATE_TRUNC('month', NOW())`;
        } else if (timeframe === '6months') {
            dateFilter = isService ? `AND sb.created_at >= NOW() - INTERVAL '6 months'` : `AND o.created_at >= NOW() - INTERVAL '6 months'`;
            previousDateFilter = isService ? `AND sb.created_at >= NOW() - INTERVAL '12 months' AND sb.created_at < NOW() - INTERVAL '6 months'` : `AND o.created_at >= NOW() - INTERVAL '12 months' AND o.created_at < NOW() - INTERVAL '6 months'`;
        } else if (timeframe === 'year') {
            dateFilter = isService ? `AND sb.created_at >= DATE_TRUNC('year', NOW())` : `AND o.created_at >= DATE_TRUNC('year', NOW())`;
            previousDateFilter = isService ? `AND sb.created_at >= DATE_TRUNC('year', NOW() - INTERVAL '1 year') AND sb.created_at < DATE_TRUNC('year', NOW())` : `AND o.created_at >= DATE_TRUNC('year', NOW() - INTERVAL '1 year') AND o.created_at < DATE_TRUNC('year', NOW())`;
        }

        const tonnageQuery = isService ? `
            SELECT COUNT(sb.id) AS total_quantity
            FROM service_bookings sb
            WHERE sb.vendor_id = $1 AND sb.status != 'cancelled' ${dateFilter}
        ` : `
            SELECT COALESCE(SUM(oi.quantity), 0) AS total_quantity
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            WHERE oi.vendor_id = $1 AND NOT (o.status = 'pending' AND o.payment_status = 'pending' AND o.source IN ('client', 'quotation')) ${dateFilter}
        `;
        const tonnageResult = await pool.query(tonnageQuery, [vendorId]);
        const totalQuantity = parseInt(tonnageResult.rows[0].total_quantity) || 0;

        const prevTonnageQuery = isService ? `
            SELECT COUNT(sb.id) AS total_quantity
            FROM service_bookings sb
            WHERE sb.vendor_id = $1 AND sb.status != 'cancelled' ${previousDateFilter}
        ` : `
            SELECT COALESCE(SUM(oi.quantity), 0) AS total_quantity
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            WHERE oi.vendor_id = $1 AND NOT (o.status = 'pending' AND o.payment_status = 'pending' AND o.source IN ('client', 'quotation')) ${previousDateFilter}
        `;
        const prevTonnageResult = await pool.query(prevTonnageQuery, [vendorId]);
        const prevTotalQuantity = parseInt(prevTonnageResult.rows[0].total_quantity) || 0;
        const tonnageGrowth = prevTotalQuantity > 0 ? ((totalQuantity - prevTotalQuantity) / prevTotalQuantity * 100) : 0;

        const aovQuery = isService ? `
            SELECT COALESCE(AVG(sb.total_amount), 0) AS avg_order_value,
                   COUNT(sb.id) AS order_count,
                   COALESCE(SUM(sb.total_amount), 0) AS total_revenue
            FROM service_bookings sb
            WHERE sb.vendor_id = $1 AND sb.status != 'cancelled' ${dateFilter}
        ` : `
            SELECT COALESCE(AVG(o.total_amount), 0) AS avg_order_value,
                   COUNT(o.id) AS order_count,
                   COALESCE(SUM(o.total_amount), 0) AS total_revenue
            FROM orders o
            WHERE o.vendor_id = $1 AND NOT (o.status = 'pending' AND o.payment_status = 'pending' AND o.source IN ('client', 'quotation')) ${dateFilter}
        `;
        const aovResult = await pool.query(aovQuery, [vendorId]);
        const avgOrderValue = parseFloat(aovResult.rows[0].avg_order_value) || 0;
        const currentRevenue = parseFloat(aovResult.rows[0].total_revenue) || 0;

        const prevAovQuery = isService ? `
            SELECT COALESCE(AVG(sb.total_amount), 0) AS avg_order_value,
                   COALESCE(SUM(sb.total_amount), 0) AS total_revenue
            FROM service_bookings sb
            WHERE sb.vendor_id = $1 AND sb.status != 'cancelled' ${previousDateFilter}
        ` : `
            SELECT COALESCE(AVG(o.total_amount), 0) AS avg_order_value,
                   COALESCE(SUM(o.total_amount), 0) AS total_revenue
            FROM orders o
            WHERE o.vendor_id = $1 AND NOT (o.status = 'pending' AND o.payment_status = 'pending' AND o.source IN ('client', 'quotation')) ${previousDateFilter}
        `;
        const prevAovResult = await pool.query(prevAovQuery, [vendorId]);
        const prevAvgOrderValue = parseFloat(prevAovResult.rows[0].avg_order_value) || 0;
        const prevRevenue = parseFloat(prevAovResult.rows[0].total_revenue) || 0;
        const aovGrowth = prevAvgOrderValue > 0 ? ((avgOrderValue - prevAvgOrderValue) / prevAvgOrderValue * 100) : 0;

        const categoryQuery = isService ? `
            SELECT 
                s.name AS category,
                COUNT(sb.id) AS total_quantity,
                COALESCE(SUM(sb.total_amount), 0) AS total_revenue
            FROM service_bookings sb
            JOIN vendor_services vs ON sb.vendor_service_id = vs.id
            JOIN services s ON vs.service_id = s.id
            WHERE sb.vendor_id = $1 AND sb.status != 'cancelled' ${dateFilter}
            GROUP BY s.name
            ORDER BY total_quantity DESC
        ` : `
            SELECT 
                pc.label AS category,
                COALESCE(SUM(oi.quantity), 0) AS total_quantity,
                COALESCE(SUM(oi.quantity * oi.price), 0) AS total_revenue
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            JOIN products p ON oi.product_id = p.id
            JOIN product_category pc ON (p.category::text = pc.id::text OR p.category::text = pc.code)
            WHERE oi.vendor_id = $1 AND NOT (o.status = 'pending' AND o.payment_status = 'pending' AND o.source IN ('client', 'quotation')) ${dateFilter}
            GROUP BY pc.label
            ORDER BY total_quantity DESC
        `;
        const categoryResult = await pool.query(categoryQuery, [vendorId]);

        const topSegment = categoryResult.rows.length > 0 ? categoryResult.rows[0] : null;
        const totalCategoryQuantity = categoryResult.rows.reduce((sum, cat) => sum + parseInt(cat.total_quantity), 0);

        let monthlyQuery = '';
        if (timeframe === 'month') {
            monthlyQuery = isService ? `
                SELECT 
                    EXTRACT(DAY FROM sb.created_at)::integer AS day_num,
                    COALESCE(SUM(sb.total_amount), 0) AS revenue
                FROM service_bookings sb
                WHERE sb.vendor_id = $1 AND sb.status != 'cancelled' ${dateFilter}
                GROUP BY EXTRACT(DAY FROM sb.created_at)
                ORDER BY day_num ASC
            ` : `
                SELECT 
                    EXTRACT(DAY FROM o.created_at)::integer AS day_num,
                    COALESCE(SUM(o.total_amount), 0) AS revenue
                FROM orders o
                WHERE o.vendor_id = $1 AND NOT (o.status = 'pending' AND o.payment_status = 'pending' AND o.source IN ('client', 'quotation')) ${dateFilter}
                GROUP BY EXTRACT(DAY FROM o.created_at)
                ORDER BY day_num ASC
            `;
        } else {
            monthlyQuery = isService ? `
                SELECT 
                    TO_CHAR(sb.created_at, 'Mon') AS month_name,
                    EXTRACT(MONTH FROM sb.created_at)::integer AS month_num,
                    COALESCE(SUM(sb.total_amount), 0) AS revenue
                FROM service_bookings sb
                WHERE sb.vendor_id = $1 AND sb.status != 'cancelled' ${dateFilter}
                GROUP BY TO_CHAR(sb.created_at, 'Mon'), EXTRACT(MONTH FROM sb.created_at)
                ORDER BY month_num ASC
            ` : `
                SELECT 
                    TO_CHAR(o.created_at, 'Mon') AS month_name,
                    EXTRACT(MONTH FROM o.created_at)::integer AS month_num,
                    COALESCE(SUM(o.total_amount), 0) AS revenue
                FROM orders o
                WHERE o.vendor_id = $1 AND NOT (o.status = 'pending' AND o.payment_status = 'pending' AND o.source IN ('client', 'quotation')) ${dateFilter}
                GROUP BY TO_CHAR(o.created_at, 'Mon'), EXTRACT(MONTH FROM o.created_at)
                ORDER BY month_num ASC
            `;
        }
        const monthlyResult = await pool.query(monthlyQuery, [vendorId]);

        const chartLabels: string[] = [];
        const chartData: number[] = [];

        if (timeframe === 'month') {
            const now = new Date();
            const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
            const revenueMap = new Map<number, number>();
            for (const row of monthlyResult.rows) {
                revenueMap.set(row.day_num, parseFloat(row.revenue));
            }
            for (let i = 1; i <= daysInMonth; i++) {
                chartLabels.push(`${i}`);
                chartData.push(revenueMap.get(i) || 0);
            }
        } else {
            const now = new Date();
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const revenueMap = new Map<string, number>();
            for (const row of monthlyResult.rows) {
                revenueMap.set(row.month_name, parseFloat(row.revenue));
            }
            
            let startMonth = 0;
            let monthsToShow = 12;
            
            if (timeframe === '6months') {
                startMonth = now.getMonth() - 5;
                monthsToShow = 6;
                if (startMonth < 0) startMonth += 12;
            }

            for (let i = 0; i < monthsToShow; i++) {
                const monthIndex = (startMonth + i) % 12;
                chartLabels.push(monthNames[monthIndex]);
                chartData.push(revenueMap.get(monthNames[monthIndex]) || 0);
            }
        }

        const topProductsQuery = isService ? `
            SELECT 
                s.id AS product_id,
                s.name AS product_name,
                pc.label AS category,
                COUNT(sb.id) AS total_sales,
                COALESCE(SUM(sb.total_amount), 0) AS total_revenue
            FROM service_bookings sb
            JOIN vendor_services vs ON sb.vendor_service_id = vs.id
            JOIN services s ON vs.service_id = s.id
            JOIN product_category pc ON s.category_id = pc.id
            WHERE sb.vendor_id = $1 AND sb.status != 'cancelled' ${dateFilter}
            GROUP BY s.id, s.name, pc.label
            ORDER BY total_sales DESC
            LIMIT 5
        ` : `
            SELECT 
                p.id AS product_id,
                p.name AS product_name,
                p.category,
                COALESCE(SUM(oi.quantity), 0) AS total_sales,
                COALESCE(SUM(oi.quantity * oi.price), 0) AS total_revenue
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            JOIN products p ON oi.product_id = p.id
            WHERE oi.vendor_id = $1 AND NOT (o.status = 'pending' AND o.payment_status = 'pending' AND o.source IN ('client', 'quotation')) ${dateFilter}
            GROUP BY p.id, p.name, p.category
            ORDER BY total_sales DESC
            LIMIT 5
        `;
        const topProductsResult = await pool.query(topProductsQuery, [vendorId]);

        const topProducts = await Promise.all(topProductsResult.rows.map(async (row: any) => {
            const prevProductQuery = isService ? `
                SELECT COUNT(sb.id) AS prev_sales
                FROM service_bookings sb
                JOIN vendor_services vs ON sb.vendor_service_id = vs.id
                WHERE sb.vendor_id = $1 AND vs.service_id = $2 AND sb.status != 'cancelled' ${previousDateFilter}
            ` : `
                SELECT COALESCE(SUM(oi.quantity), 0) AS prev_sales
                FROM order_items oi
                JOIN orders o ON oi.order_id = o.id
                WHERE oi.vendor_id = $1 AND oi.product_id = $2 AND NOT (o.status = 'pending' AND o.payment_status = 'pending' AND o.source IN ('client', 'quotation')) ${previousDateFilter}
            `;
            const prevProductResult = await pool.query(prevProductQuery, [vendorId, row.product_id]);
            const prevSales = parseInt(prevProductResult.rows[0]?.prev_sales) || 0;
            const currentSales = parseInt(row.total_sales);
            const growth = prevSales > 0 ? ((currentSales - prevSales) / prevSales * 100) : 0;

            return {
                id: row.product_id,
                name: row.product_name,
                category: row.category || 'Uncategorized',
                sales: currentSales,
                revenue: parseFloat(row.total_revenue) || 0,
                growth: growth,
            };
        }));

        return res.status(200).json({
            message: "Analytics data fetched successfully",
            data: {
                vendorType: isService ? 'service' : 'product',
                kpi: {
                    totalQuantity: totalQuantity,
                    tonnageGrowth: parseFloat(tonnageGrowth.toFixed(1)),
                    avgOrderValue: avgOrderValue,
                    aovGrowth: parseFloat(aovGrowth.toFixed(1)),
                    topSegment: topSegment ? {
                        name: topSegment.category || 'Unknown',
                        volume: parseInt(topSegment.total_quantity),
                        percentage: totalCategoryQuantity > 0 ? parseFloat((parseInt(topSegment.total_quantity) / totalCategoryQuantity * 100).toFixed(1)) : 0,
                    } : null,
                    totalRevenue: currentRevenue,
                    revenueGrowth: prevRevenue > 0 ? parseFloat(((currentRevenue - prevRevenue) / prevRevenue * 100).toFixed(1)) : 0,
                },
                revenueChart: {
                    labels: chartLabels,
                    data: chartData,
                },
                categoryDistribution: categoryResult.rows.map((row: any) => ({
                    name: row.category || 'Uncategorized',
                    quantity: parseInt(row.total_quantity) || 0,
                    revenue: parseFloat(row.total_revenue) || 0,
                    percentage: totalCategoryQuantity > 0 ? parseFloat((parseInt(row.total_quantity) / totalCategoryQuantity * 100).toFixed(1)) : 0,
                })),
                topProducts: topProducts,
            }
        });
    } catch (e) {
        console.error("Error fetching vendor analytics:", e);
        return res.status(500).json({ message: "Internal server error" });
    }
};
