// Open-source icons: lucide (https://lucide.dev, ISC license).
// Thin 1.75px strokes match the strict monochrome design.

import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Check,
  CheckCircle2,
  ChevronRight,
  CloudDownload,
  Copy,
  Clock3,
  CornerUpRight,
  Cpu,
  ExternalLink,
  Folder,
  FolderOpen,
  FolderPlus,
  Files,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  Image,
  Info,
  Pencil,
  MessageSquare,
  MessageSquarePlus,
  Minus,
  Monitor,
  Package,
  Palette,
  PanelLeft,
  Smartphone,
  Tablet,
  Paperclip,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Settings,
  ShieldQuestion,
  Square,
  Trash2,
  Undo2,
} from "lucide-react";

interface IconProps {
  size?: number;
  motion?: "spin" | "pulse" | "lift";
}

const SW = 1.75;
const motionClass = (motion?: IconProps["motion"]) => motion ? `motion-icon motion-${motion}` : undefined;

export const ChatIcon = ({ size = 15 }: IconProps) => <MessageSquare size={size} strokeWidth={SW} />;
export const ReviewIcon = ({ size = 15 }: IconProps) => <GitBranch size={size} strokeWidth={SW} />;
export const ChartIcon = ({ size = 15 }: IconProps) => <BarChart3 size={size} strokeWidth={SW} />;
export const GearIcon = ({ size = 15 }: IconProps) => <Settings size={size} strokeWidth={SW} />;
export const FolderIcon = ({ size = 15 }: IconProps) => <FolderOpen size={size} strokeWidth={SW} />;
export const PlusIcon = ({ size = 15 }: IconProps) => <Plus size={size} strokeWidth={SW} />;
export const SendIcon = ({ size = 15, motion }: IconProps) => <ArrowUp className={motionClass(motion)} size={size} strokeWidth={2.25} />;
export const SteerIcon = ({ size = 15, motion }: IconProps) => <CornerUpRight className={motionClass(motion)} size={size} strokeWidth={2.1} />;
export const StopIcon = ({ size = 15 }: IconProps) => <Square size={size} strokeWidth={SW} fill="currentColor" />;
export const ExternalIcon = ({ size = 15 }: IconProps) => <ExternalLink size={size} strokeWidth={SW} />;
export const PaperclipIcon = ({ size = 15 }: IconProps) => <Paperclip size={size} strokeWidth={SW} />;
export const RefreshIcon = ({ size = 15, motion }: IconProps) => <RefreshCw className={motionClass(motion)} size={size} strokeWidth={SW} />;
export const ModelIcon = ({ size = 15, motion }: IconProps) => <Cpu className={motionClass(motion)} size={size} strokeWidth={SW} />;
export const ImageIcon = ({ size = 15 }: IconProps) => <Image size={size} strokeWidth={SW} />;
export const RevertIcon = ({ size = 15 }: IconProps) => <Undo2 size={size} strokeWidth={SW} />;
export const CommentIcon = ({ size = 15 }: IconProps) => <MessageSquarePlus size={size} strokeWidth={SW} />;
export const CheckIcon = ({ size = 15 }: IconProps) => <Check size={size} strokeWidth={SW} />;
export const CopyIcon = ({ size = 15 }: IconProps) => <Copy size={size} strokeWidth={SW} />;
export const TimeIcon = ({ size = 15 }: IconProps) => <Clock3 size={size} strokeWidth={SW} />;
export const FilesIcon = ({ size = 15 }: IconProps) => <Files size={size} strokeWidth={SW} />;
export const EditIcon = ({ size = 15 }: IconProps) => <Pencil size={size} strokeWidth={SW} />;

export const InfoIcon = ({ size = 15 }: IconProps) => <Info size={size} strokeWidth={SW} />;
export const SuccessIcon = ({ size = 15 }: IconProps) => <CheckCircle2 size={size} strokeWidth={SW} />;
export const WarnIcon = ({ size = 15 }: IconProps) => <AlertTriangle size={size} strokeWidth={SW} />;
export const ErrorIcon = ({ size = 15 }: IconProps) => <AlertCircle size={size} strokeWidth={SW} />;
export const ShieldIcon = ({ size = 15 }: IconProps) => <ShieldQuestion size={size} strokeWidth={SW} />;
export const MinusIcon = ({ size = 15 }: IconProps) => <Minus size={size} strokeWidth={SW} />;
export const CommitIcon = ({ size = 15 }: IconProps) => <GitCommitHorizontal size={size} strokeWidth={SW} />;
export const BranchIcon = ({ size = 15 }: IconProps) => <GitBranch size={size} strokeWidth={SW} />;
export const TrashIcon = ({ size = 15 }: IconProps) => <Trash2 size={size} strokeWidth={SW} />;
export const PullIcon = ({ size = 15 }: IconProps) => <ArrowDown size={size} strokeWidth={SW} />;
export const PushIcon = ({ size = 15 }: IconProps) => <ArrowUp size={size} strokeWidth={SW} />;
export const FetchIcon = ({ size = 15 }: IconProps) => <CloudDownload size={size} strokeWidth={SW} />;
export const ForkIcon = ({ size = 15 }: IconProps) => <GitFork size={size} strokeWidth={SW} />;
export const RewindIcon = ({ size = 15 }: IconProps) => <RotateCcw size={size} strokeWidth={SW} />;
export const PinIcon = ({ size = 15 }: IconProps) => <Pin size={size} strokeWidth={SW} />;
export const PinOffIcon = ({ size = 15 }: IconProps) => <PinOff size={size} strokeWidth={SW} />;
export const SidebarIcon = ({ size = 15 }: IconProps) => <PanelLeft size={size} strokeWidth={SW} />;
export const FolderPlusIcon = ({ size = 15 }: IconProps) => <FolderPlus size={size} strokeWidth={SW} />;
export const GroupIcon = ({ size = 15 }: IconProps) => <Folder size={size} strokeWidth={SW} />;
export const UpdateIcon = ({ size = 15, motion }: IconProps) => <Sparkles className={motionClass(motion)} size={size} strokeWidth={SW} />;
export const PreviewIcon = ({ size = 15 }: IconProps) => <Monitor size={size} strokeWidth={SW} />;
export const PackageIcon = ({ size = 15 }: IconProps) => <Package size={size} strokeWidth={SW} />;
export const AppearanceIcon = ({ size = 15 }: IconProps) => <Palette size={size} strokeWidth={SW} />;
export const TabletIcon = ({ size = 15 }: IconProps) => <Tablet size={size} strokeWidth={SW} />;
export const MobileIcon = ({ size = 15 }: IconProps) => <Smartphone size={size} strokeWidth={SW} />;

export const ChevronIcon = ({ size = 13, open }: IconProps & { open?: boolean }) => (
  <ChevronRight
    size={size}
    strokeWidth={SW}
    style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s ease" }}
  />
);
