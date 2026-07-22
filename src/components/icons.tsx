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
  ListTodo,
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
const iconClass = (motion?: IconProps["motion"]) => ["ui-icon", motionClass(motion)].filter(Boolean).join(" ");
const iconProps = (size: number, motion?: IconProps["motion"], strokeWidth = SW) => ({
  className: iconClass(motion),
  size,
  strokeWidth,
});

export const ChatIcon = ({ size = 15 }: IconProps) => <MessageSquare {...iconProps(size)} />;
export const ReviewIcon = ({ size = 15 }: IconProps) => <GitBranch {...iconProps(size)} />;
export const ChartIcon = ({ size = 15 }: IconProps) => <BarChart3 {...iconProps(size)} />;
export const GearIcon = ({ size = 15 }: IconProps) => <Settings {...iconProps(size)} />;
export const FolderIcon = ({ size = 15 }: IconProps) => <FolderOpen {...iconProps(size)} />;
export const PlusIcon = ({ size = 15 }: IconProps) => <Plus {...iconProps(size)} />;
export const SendIcon = ({ size = 15, motion }: IconProps) => <ArrowUp {...iconProps(size, motion, 2.25)} />;
export const SteerIcon = ({ size = 15, motion }: IconProps) => <CornerUpRight {...iconProps(size, motion, 2.1)} />;
export const StopIcon = ({ size = 15 }: IconProps) => <Square {...iconProps(size)} fill="currentColor" />;
export const ExternalIcon = ({ size = 15 }: IconProps) => <ExternalLink {...iconProps(size)} />;
export const PaperclipIcon = ({ size = 15 }: IconProps) => <Paperclip {...iconProps(size)} />;
export const RefreshIcon = ({ size = 15, motion }: IconProps) => <RefreshCw {...iconProps(size, motion)} />;
export const ModelIcon = ({ size = 15, motion }: IconProps) => <Cpu {...iconProps(size, motion)} />;
export const ImageIcon = ({ size = 15 }: IconProps) => <Image {...iconProps(size)} />;
export const RevertIcon = ({ size = 15 }: IconProps) => <Undo2 {...iconProps(size)} />;
export const CommentIcon = ({ size = 15 }: IconProps) => <MessageSquarePlus {...iconProps(size)} />;
export const CheckIcon = ({ size = 15 }: IconProps) => <Check {...iconProps(size)} />;
export const CopyIcon = ({ size = 15 }: IconProps) => <Copy {...iconProps(size)} />;
export const TimeIcon = ({ size = 15 }: IconProps) => <Clock3 {...iconProps(size)} />;
export const TasksIcon = ({ size = 15, motion }: IconProps) => <ListTodo {...iconProps(size, motion)} />;
export const FilesIcon = ({ size = 15 }: IconProps) => <Files {...iconProps(size)} />;
export const EditIcon = ({ size = 15 }: IconProps) => <Pencil {...iconProps(size)} />;

export const InfoIcon = ({ size = 15 }: IconProps) => <Info {...iconProps(size)} />;
export const SuccessIcon = ({ size = 15 }: IconProps) => <CheckCircle2 {...iconProps(size)} />;
export const WarnIcon = ({ size = 15 }: IconProps) => <AlertTriangle {...iconProps(size)} />;
export const ErrorIcon = ({ size = 15 }: IconProps) => <AlertCircle {...iconProps(size)} />;
export const ShieldIcon = ({ size = 15 }: IconProps) => <ShieldQuestion {...iconProps(size)} />;
export const MinusIcon = ({ size = 15 }: IconProps) => <Minus {...iconProps(size)} />;
export const CommitIcon = ({ size = 15 }: IconProps) => <GitCommitHorizontal {...iconProps(size)} />;
export const BranchIcon = ({ size = 15 }: IconProps) => <GitBranch {...iconProps(size)} />;
export const TrashIcon = ({ size = 15 }: IconProps) => <Trash2 {...iconProps(size)} />;
export const PullIcon = ({ size = 15 }: IconProps) => <ArrowDown {...iconProps(size)} />;
export const PushIcon = ({ size = 15 }: IconProps) => <ArrowUp {...iconProps(size)} />;
export const FetchIcon = ({ size = 15 }: IconProps) => <CloudDownload {...iconProps(size)} />;
export const ForkIcon = ({ size = 15 }: IconProps) => <GitFork {...iconProps(size)} />;
export const RewindIcon = ({ size = 15 }: IconProps) => <RotateCcw {...iconProps(size)} />;
export const PinIcon = ({ size = 15 }: IconProps) => <Pin {...iconProps(size)} />;
export const PinOffIcon = ({ size = 15 }: IconProps) => <PinOff {...iconProps(size)} />;
export const SidebarIcon = ({ size = 15 }: IconProps) => <PanelLeft {...iconProps(size)} />;
export const FolderPlusIcon = ({ size = 15 }: IconProps) => <FolderPlus {...iconProps(size)} />;
export const GroupIcon = ({ size = 15 }: IconProps) => <Folder {...iconProps(size)} />;
export const UpdateIcon = ({ size = 15, motion }: IconProps) => <Sparkles {...iconProps(size, motion)} />;
export const PreviewIcon = ({ size = 15 }: IconProps) => <Monitor {...iconProps(size)} />;
export const PackageIcon = ({ size = 15 }: IconProps) => <Package {...iconProps(size)} />;
export const AppearanceIcon = ({ size = 15 }: IconProps) => <Palette {...iconProps(size)} />;
export const TabletIcon = ({ size = 15 }: IconProps) => <Tablet {...iconProps(size)} />;
export const MobileIcon = ({ size = 15 }: IconProps) => <Smartphone {...iconProps(size)} />;

export const ChevronIcon = ({ size = 13, open }: IconProps & { open?: boolean }) => (
  <ChevronRight
    className="ui-icon"
    size={size}
    strokeWidth={SW}
    style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s ease" }}
  />
);
