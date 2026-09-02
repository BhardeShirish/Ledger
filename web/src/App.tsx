import React, { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import Layout from "./components/Layout";
import AppErrorBoundary from "./components/AppErrorBoundary";
import { AuthProvider, useAuth } from "./lib/auth";
import { MoneyProvider } from "./lib/money";
const Advances = lazy(() => import("./pages/Advances"));
const AttendanceGrid = lazy(() => import("./pages/AttendanceGrid"));
const Bills = lazy(() => import("./pages/Bills"));
const CashRegister = lazy(() => import("./pages/CashRegister"));
const UnitPrices = lazy(() => import("./pages/UnitPrices"));
const InventoryLayout = lazy(() => import("./pages/Inventory"));
const InventoryOverview = lazy(() => import("./pages/InventoryOverview"));
const InventoryItems = lazy(() => import("./pages/InventoryItems"));
const InventoryLinks = lazy(() => import("./pages/InventoryLinks"));
const InventoryCounts = lazy(() => import("./pages/InventoryCounts"));
const InventoryWastage = lazy(() => import("./pages/InventoryWastage"));
const InventoryOrder = lazy(() => import("./pages/InventoryOrder"));
const DailyBrief = lazy(() => import("./pages/DailyBrief"));
const Analytics = lazy(() => import("./pages/Analytics"));
const Home = lazy(() => import("./pages/Home"));
const ImportWizard = lazy(() => import("./pages/ImportWizard"));
const BankImport = lazy(() => import("./pages/BankImport"));
const Login = lazy(() => import("./pages/Login"));
const PayrollRuns = lazy(() => import("./pages/PayrollRuns"));
const PeopleList = lazy(() => import("./pages/PeopleList"));
const PersonDetail = lazy(() => import("./pages/PersonDetail"));
const Reports = lazy(() => import("./pages/Reports"));
const SalesSheet = lazy(() => import("./pages/SalesSheet"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const ShiftsBoard = lazy(() => import("./pages/ShiftsBoard"));
const VendorDetail = lazy(() => import("./pages/VendorDetail"));
const VendorsList = lazy(() => import("./pages/VendorsList"));
const ExpensesList = lazy(() => import("./pages/ExpensesList"));
const PayrollRunDetail = lazy(() => import("./pages/PayrollRunDetail"));

function Protected() {
  const { me, ready } = useAuth();
  if (!ready) return <div className="p-10 text-center text-ink-faint">…</div>;
  if (!me) return <Navigate to="/login" replace />;
  return <Layout />;
}

function RedirectOldPayroll() {
  const { id } = useParams();
  return <Navigate to={`/staff/payroll/${id}`} replace />;
}

function NotFound() {
  return (
    <main className="mx-auto max-w-md p-10 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-ink-faint">
        Check the address or return to the Ledger home page.
      </p>
      <a href="/" className="mt-4 inline-block text-accent underline">Go home</a>
    </main>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <MoneyProvider>
      <AuthProvider>
        <AppErrorBoundary>
        <Suspense fallback={<div className="p-10 text-center text-ink-faint">Loading…</div>}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<Protected />}>
            <Route path="/" element={<Home />} />
            <Route path="/sales" element={<SalesSheet />} />
            <Route path="/sales/bills" element={<Bills />} />
            <Route path="/sales/import" element={<ImportWizard />} />
            <Route path="/staff/attendance" element={<AttendanceGrid />} />
            <Route path="/staff/people" element={<PeopleList />} />
            <Route path="/staff/people/:id" element={<PersonDetail />} />
            <Route path="/staff/shifts" element={<ShiftsBoard />} />
            <Route path="/money/expenses" element={<ExpensesList />} />
            <Route path="/money/vendors" element={<VendorsList />} />
            <Route path="/money/vendors/:id" element={<VendorDetail />} />
            <Route path="/money/cash" element={<CashRegister />} />
            <Route path="/money/unitprices" element={<UnitPrices />} />
            <Route path="/money/bank" element={<BankImport />} />
            <Route path="/inventory" element={<InventoryLayout />}>
              <Route index element={<InventoryOverview />} />
              <Route path="items" element={<InventoryItems />} />
              <Route path="links" element={<InventoryLinks />} />
              <Route path="counts" element={<InventoryCounts />} />
              <Route path="wastage" element={<InventoryWastage />} />
              <Route path="order" element={<InventoryOrder />} />
            </Route>
            <Route path="/brief" element={<DailyBrief />} />
            <Route path="/staff/payroll" element={<PayrollRuns />} />
            <Route path="/staff/payroll/:id" element={<PayrollRunDetail />} />
            <Route path="/staff/advances" element={<Advances />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/reports/analytics" element={<Analytics />} />
            <Route path="/settings/*" element={<SettingsPage />} />
            {/* Inside Protected so a mistyped URL keeps the sidebar and reads
                as "wrong address", not "the app broke". */}
            <Route path="*" element={<NotFound />} />
          </Route>
          <Route path="/money/payroll" element={<Navigate to="/staff/payroll" replace />} />
          <Route path="/money/payroll/:id" element={<RedirectOldPayroll />} />
        </Routes>
        </Suspense>
        </AppErrorBoundary>
      </AuthProvider>
      </MoneyProvider>
    </BrowserRouter>
  );
}
